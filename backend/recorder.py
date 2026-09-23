"""WASAPI loopback recording, durable WAV output and completed chunks for ASR."""
from __future__ import annotations

from array import array
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from queue import Empty, Full, Queue
import shutil
import threading
import time
import uuid
import wave

CHUNK_SECONDS = 5
MAX_BYTES = 1024 ** 3
MAX_SECONDS = 60 * 60 * 2


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def save_json(path: Path, data: dict):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def audio_module():
    try:
        import pyaudiowpatch
        return pyaudiowpatch
    except ImportError as exc:
        raise RuntimeError('Запись требует Windows и PyAudioWPatch. Запустите setup.cmd.') from exc


def list_devices():
    pa = audio_module()
    with pa.PyAudio() as audio:
        try:
            default = audio.get_default_wasapi_loopback()['index']
        except (OSError, ValueError):
            default = None
        return [
            {'id': d['index'], 'name': d['name'], 'sample_rate': int(d['defaultSampleRate']),
             'channels': int(d['maxInputChannels']), 'default': d['index'] == default}
            for d in audio.get_loopback_device_info_generator() if d['maxInputChannels'] > 0
        ]


class AudioFiles:
    """Single writer. Publish a chunk only after its WAV header is finalized."""
    def __init__(self, directory: Path, rate: int, channels: int):
        self.directory, self.rate, self.channels = directory, rate, channels
        self.frame_size = channels * 2
        self.chunk_bytes = CHUNK_SECONDS * rate * self.frame_size
        self.pending = bytearray()
        self.frames = 0
        self.chunks = []
        self.main = wave.open(str(directory / 'recording.wav'), 'wb')
        self.main.setparams((channels, 2, rate, 0, 'NONE', 'not compressed'))

    def write(self, pcm: bytes):
        if len(pcm) % self.frame_size:
            raise ValueError('Получен неполный аудиокадр.')
        self.main.writeframes(pcm)
        self.frames += len(pcm) // self.frame_size
        self.pending.extend(pcm)
        while len(self.pending) >= self.chunk_bytes:
            self._publish(bytes(self.pending[:self.chunk_bytes]))
            del self.pending[:self.chunk_bytes]

    def _publish(self, pcm: bytes):
        index = len(self.chunks)
        filename = f'chunk-{index:05d}.wav'
        part = self.directory / (filename + '.part')
        with wave.open(str(part), 'wb') as out:
            out.setparams((self.channels, 2, self.rate, 0, 'NONE', 'not compressed'))
            out.writeframes(pcm)
        part.replace(self.directory / filename)
        self.chunks.append({'index': index, 'file': filename, 'start': index * CHUNK_SECONDS,
                            'duration': len(pcm) / self.frame_size / self.rate})

    def close(self):
        try:
            if self.pending:
                self._publish(bytes(self.pending))
                self.pending.clear()
        finally:
            self.main.close()


class Recorder:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.thread = None
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.current = None
        self.started_clock = 0.0
        self.last_frame_clock = 0.0
        # Previous process may have been killed before finalization.
        for path in root.glob('*/session.json'):
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                if data.get('status') in ('starting', 'recording', 'stopping'):
                    data.update(status='interrupted', error='Предыдущий процесс завершился во время записи.')
                    save_json(path, data)
            except (OSError, ValueError):
                continue

    def snapshot(self):
        with self.lock:
            if self.current is None:
                return None
            data = json.loads(json.dumps(self.current))
            if self.thread and self.thread.is_alive():
                data['elapsed_seconds'] = round(time.monotonic() - self.started_clock, 1)
                since = time.monotonic() - self.last_frame_clock
                data['level'] = data['level'] if since < 1 else 0
                if since > 8:
                    data['warning'] = 'Аудиокадры не поступают. Проверьте выбранное устройство и звук встречи.'
            return data

    def _save(self):
        with self.lock:
            save_json(self.root / self.current['id'] / 'session.json', self.current)

    def start(self, *, device_id: int, title: str, platform: str):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError('Запись уже запущена. Сначала остановите текущую сессию.')
            if shutil.disk_usage(self.root).free < 512 * 1024 * 1024:
                raise ValueError('Для записи требуется хотя бы 512 МБ свободного места.')
            session_id = uuid.uuid4().hex
            (self.root / session_id).mkdir()
            self.current = {
                'schema_version': 1, 'id': session_id, 'title': title, 'platform': platform,
                'source': 'wasapi_loopback', 'status': 'starting', 'created_at': utc_now(),
                'sample_rate': None, 'channels': None, 'sample_width': 2,
                'audio_file': 'recording.wav', 'duration_seconds': 0, 'elapsed_seconds': 0,
                'level': 0, 'chunks': [], 'error': None, 'warning': None,
                'connection': 'operator_managed',
            }
            self.started_clock = self.last_frame_clock = time.monotonic()
            self.stop_event = threading.Event()
            self.ready = threading.Event()
            self._save()
            self.thread = threading.Thread(target=self._record, args=(device_id,), daemon=True)
            self.thread.start()
        if not self.ready.wait(8):
            self.stop_event.set()
            raise RuntimeError('Устройство не ответило за 8 секунд. Запись отменяется.')
        result = self.snapshot()
        if result['status'] == 'error':
            raise RuntimeError(result['error'])
        return result

    def stop(self):
        with self.lock:
            worker = self.thread
            if not worker or not worker.is_alive():
                return self.snapshot()
            self.current['status'] = 'stopping'
            self.stop_event.set()
        worker.join(timeout=8)
        return self.snapshot()

    def _record(self, device_id):
        files = stream = audio = None
        queue = Queue(maxsize=256)
        callback_errors = []
        try:
            pa = audio_module()
            audio = pa.PyAudio()
            device = audio.get_device_info_by_index(device_id)
            if not device.get('isLoopbackDevice') or device['maxInputChannels'] < 1:
                raise ValueError('Выберите устройство системного звука (Loopback).')
            rate, channels = int(device['defaultSampleRate']), int(device['maxInputChannels'])
            files = AudioFiles(self.root / self.current['id'], rate, channels)

            def callback(data, frame_count, time_info, status):
                if status:
                    callback_errors.append(f'Переполнение или ошибка аудиопотока: {status}.')
                    self.stop_event.set()
                if data:
                    try:
                        queue.put_nowait(data)
                    except Full:
                        callback_errors.append('Запись на диск не успевает за аудиопотоком.')
                        self.stop_event.set()
                return (None, pa.paComplete if self.stop_event.is_set() else pa.paContinue)

            stream = audio.open(format=pa.paInt16, channels=channels, rate=rate,
                                input=True, input_device_index=device_id,
                                frames_per_buffer=1024, stream_callback=callback, start=False)
            with self.lock:
                self.current.update(status='recording', sample_rate=rate, channels=channels,
                                    device_name=device['name'], started_at=utc_now())
            self._save()
            stream.start_stream()
            self.ready.set()
            saved_chunks = 0
            last_space_check = time.monotonic()

            def consume(data):
                files.write(data)
                samples = array('h', data)
                level = math.sqrt(sum(v * v for v in samples) / max(1, len(samples))) / 32768
                with self.lock:
                    self.last_frame_clock = time.monotonic()
                    self.current.update(duration_seconds=round(files.frames / rate, 3),
                                        level=round(min(1, level * 4), 4), chunks=list(files.chunks))

            while not self.stop_event.is_set():
                try:
                    consume(queue.get(timeout=.2))
                except Empty:
                    if not stream.is_active():
                        raise RuntimeError('Аудиоустройство остановило поток. Проверьте подключение.')
                if len(files.chunks) != saved_chunks:
                    self._save()
                    saved_chunks = len(files.chunks)
                if files.frames * files.frame_size >= MAX_BYTES or time.monotonic() - self.started_clock >= MAX_SECONDS:
                    with self.lock:
                        self.current['warning'] = 'Запись остановлена: лимит 1 ГБ или 2 часа на сессию.'
                    self.stop_event.set()
                if time.monotonic() - last_space_check > 10:
                    last_space_check = time.monotonic()
                    if shutil.disk_usage(self.root).free < 100 * 1024 * 1024:
                        raise RuntimeError('Недостаточно свободного места. Запись остановлена.')
            stream.stop_stream()
            while not queue.empty():
                consume(queue.get_nowait())
            if callback_errors:
                raise RuntimeError(callback_errors[0])
        except Exception as exc:
            with self.lock:
                self.current.update(status='error', error=str(exc))
        finally:
            try:
                if stream:
                    stream.close()
                if audio:
                    audio.terminate()
                if files:
                    files.close()
            except Exception as exc:
                with self.lock:
                    self.current.update(status='error', error=f'Не удалось завершить WAV: {exc}')
            with self.lock:
                if files:
                    self.current['chunks'] = list(files.chunks)
                if self.current['status'] != 'error':
                    self.current['status'] = 'completed'
                self.current.update(level=0, stopped_at=utc_now(),
                                    elapsed_seconds=round(time.monotonic() - self.started_clock, 1))
                if not self.current['duration_seconds'] and not self.current['error']:
                    self.current['warning'] = 'Запись пуста: аудиокадры не поступили.'
                self._save()
            self.ready.set()
