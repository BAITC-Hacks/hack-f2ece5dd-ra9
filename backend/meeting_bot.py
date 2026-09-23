"""Browser guest assistant. Admission is confirmed by the meeting UI, never by launch."""
import re
import threading
import time
import uuid

from .teams import validate_meeting_url, meeting_platform

LEAVE = re.compile(r'^(Leave(?: meeting)?(?:\s|$)|Покинуть|Выйти из|Завершить звонок|Отключиться)', re.I)


def visible_control(frame, role, pattern):
    try:
        controls = frame.get_by_role(role, name=pattern)
        for index in range(min(controls.count(), 8)):
            control = controls.nth(index)
            if control.is_visible() and control.is_enabled():
                return control
    except Exception:
        # Teams replaces its launcher frame while navigating into the call.
        # Re-discover it on the next iteration instead of aborting the guest.
        return None
    return None


class MeetingBot:
    def __init__(self, recorder, transcription):
        self.recorder, self.transcription = recorder, transcription
        self.lock = threading.RLock()
        self.worker = None
        self.state = None
        self.stop_event = threading.Event()
        self.confirm_event = threading.Event()

    def snapshot(self):
        with self.lock:
            return dict(self.state) if self.state else None

    def _set(self, **fields):
        with self.lock:
            self.state.update(fields)

    def ensure_idle(self):
        if self.worker and self.worker.is_alive():
            raise ValueError('Подключение к другой встрече уже открыто.')

    def start(self, *, url, title, device_id):
        url = validate_meeting_url(url)
        with self.lock:
            self.ensure_idle()
            self.state = {'id': uuid.uuid4().hex, 'status': 'opening', 'session_id': None,
                          'platform': meeting_platform(url), 'message': 'Открываем браузер встречи.', 'error': None}
            self.stop_event = threading.Event()
            self.confirm_event = threading.Event()
            self.worker = threading.Thread(target=self._run, args=(url, title, device_id), daemon=True)
            self.worker.start()
            return self.snapshot()

    def confirm(self):
        state = self.snapshot()
        if not state or state['status'] not in ('joining', 'waiting', 'needs_action'):
            raise ValueError('Нет открытого подключения для подтверждения.')
        self.confirm_event.set()
        return state

    def stop(self):
        self.stop_event.set()
        if self.worker and self.worker.is_alive():
            self.worker.join(timeout=3)
        return self.snapshot()

    def _advance_join(self, page, clicked_join):
        for frame in page.frames:
            try:
                if frame.is_detached():
                    continue
                for role in ('button', 'link'):
                    control = visible_control(frame, role, re.compile(r'(Continue on this browser|Continue in this browser|Join from Your Browser|Продолжить в (этом )?браузере|Присоединиться из браузера|Войти из браузера)', re.I))
                    if control:
                        control.click()
                        return clicked_join
                name = visible_control(frame, 'textbox', re.compile(r'(Your name|Enter.*name|Имя|Введите имя)', re.I))
                if name and not name.input_value():
                    name.fill('AI Протоколист')
                names = frame.get_by_placeholder(re.compile(r'(name|имя)', re.I))
                if names.count() and names.first.is_visible() and not names.first.input_value():
                    names.first.fill('AI Протоколист')
                mute = visible_control(frame, 'button', re.compile(r'^(Mute(?:\s|$)|Turn off microphone|Выключить микрофон|Отключить микрофон)', re.I))
                if mute:
                    mute.click()
                camera = visible_control(frame, 'button', re.compile(r'^(Turn off camera|Stop video|Выключить камеру|Отключить камеру|Остановить видео)', re.I))
                if camera:
                    camera.click()
                join = visible_control(frame, 'button', re.compile(r'^(Join now|Ask to join|Join meeting|Join$|Присоединиться сейчас|Присоединиться$|Присоединиться к встрече|Войти$|Отправить запрос)', re.I))
                if join and not clicked_join:
                    join.click()
                    self._set(status='waiting', message='Ожидаем допуска организатора. Если браузер просит дополнительные действия, выполните их в окне встречи.')
                    return True
            except Exception:
                continue
        return clicked_join

    def _run(self, url, title, device_id):
        browser = None
        session_id = None
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as driver:
                # Synthetic input devices prevent transmission of the operator's
                # physical microphone/camera even if a meeting enables them.
                args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                        '--autoplay-policy=no-user-gesture-required']
                for channel in ('msedge', 'chrome'):
                    try:
                        browser = driver.chromium.launch(channel=channel, headless=False, args=args)
                        break
                    except Exception:
                        continue
                if browser is None:
                    raise RuntimeError('Не удалось открыть Edge/Chrome. Установите один из этих браузеров.')
                context = browser.new_context(locale='ru-RU', viewport={'width': 1200, 'height': 800})
                page = context.new_page()
                page.set_default_timeout(1500)
                page.goto(url, wait_until='domcontentloaded', timeout=45000)
                self._set(status='joining', message='Входим как AI Протоколист. Организатор должен разрешить гостевой вход.')
                joined = False
                started = time.monotonic()
                clicked_join = False
                while not self.stop_event.is_set():
                    if page.is_closed():
                        break
                    frames = page.frames
                    detected = any(visible_control(frame, 'button', LEAVE) for frame in frames)
                    if not joined and (detected or self.confirm_event.is_set()):
                        for frame in frames:
                            audio_join = visible_control(frame, 'button', re.compile(r'^(Join Audio|Join with Computer Audio|Войти с использованием звука компьютера|Подключить звук)', re.I))
                            if audio_join:
                                audio_join.click()
                        result = self.recorder.start(device_id=device_id, title=title, platform=meeting_platform(url))
                        session_id = result['id']
                        self.transcription.start(session_id)
                        joined = True
                        self._set(status='recording', session_id=session_id, message='Идёт запись и распознавание разговора.')
                    if joined:
                        current = self.recorder.snapshot()
                        if current and current['id'] == session_id and current['status'] in ('completed', 'error', 'interrupted'):
                            break
                        body = page.locator('body').inner_text(timeout=1500)
                        if not detected and re.search(r'(You left the meeting|meeting has ended|Встреча завершена|Вы покинули|Вы вышли из|Звонок завершен|Видеовстреча завершена)', body, re.I):
                            break
                    else:
                        clicked_join = self._advance_join(page, clicked_join)
                        if time.monotonic() - started > 35 and not clicked_join:
                            self._set(status='needs_action', message='Завершите вход в открытом браузере. После допуска запись начнётся автоматически; при необходимости нажмите «Я уже в звонке».')
                    self.stop_event.wait(1)
                if session_id:
                    self.recorder.stop()
                    self.transcription.notify()
                self._set(status='finished', message='Подключение завершено. Обрабатываем оставшийся звук.')
                browser.close()
        except Exception as exc:
            if session_id:
                self.recorder.stop()
                self.transcription.notify()
            self._set(status='error', error=str(exc), message='Не удалось завершить автоматическое подключение. Запись, если она началась, сохранена.')
        finally:
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
