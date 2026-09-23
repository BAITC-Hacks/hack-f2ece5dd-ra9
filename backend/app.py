"""Local-only API and UI. Start: python -m backend --port 8765."""
from contextlib import asynccontextmanager
import json
from pathlib import Path
import re
import secrets
import threading
import shutil
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .recorder import Recorder, list_devices
from .teams import open_guest_window
from .transcription import TranscriptManager, recognizer_available
from .analysis import read_analysis, analyze_segments
from .uploads import UploadManager, EXTENSIONS, MAX_UPLOAD_BYTES
from .meeting_bot import MeetingBot

ROOT = Path(__file__).resolve().parent.parent


class StartRequest(BaseModel):
    device_id: int = Field(ge=0)
    title: str = Field(default='Совещание', min_length=1, max_length=100)
    platform: str = Field(default='Teams', pattern=r'^(Teams|Zoom|Google Meet|Local)$')
    acknowledged: bool = False


class TeamsRequest(BaseModel):
    url: str = Field(min_length=10, max_length=4096)


class ConnectRequest(TeamsRequest):
    title: str = Field(default='Совещание', min_length=1, max_length=180)
    device_id: int = Field(ge=0)
    acknowledged: bool = False


def create_app(data_root: Path | None = None, recorder=None, transcription=None):
    data_root = data_root or ROOT / 'sessions'
    recorder = recorder or Recorder(data_root)
    transcription = transcription or TranscriptManager(data_root)
    uploads = UploadManager(data_root, transcription)
    bot = MeetingBot(recorder, transcription)
    operation_lock = threading.Lock()
    token = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(app):
        yield
        bot.stop()
        recorder.stop()

    app = FastAPI(title='AI Протоколист — запись и транскрипция', version='0.3.0', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])

    @app.middleware('http')
    async def guard(request: Request, call_next):
        if request.url.path == '/api/jobs' and request.method == 'POST':
            try:
                if int(request.headers.get('content-length', '0')) > MAX_UPLOAD_BYTES + 1024 * 1024:
                    return JSONResponse({'detail': 'Файл превышает 200 МБ.'}, status_code=413)
            except ValueError:
                return JSONResponse({'detail': 'Неверный размер запроса.'}, status_code=400)
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            origin = request.headers.get('origin')
            if origin and (urlsplit(origin).netloc != request.headers.get('host') or urlsplit(origin).scheme != 'http'):
                return JSONResponse({'detail': 'Запрос должен поступать из локального интерфейса.'}, status_code=403)
            if not secrets.compare_digest(request.headers.get('x-recorder-token', ''), token):
                return JSONResponse({'detail': 'Обновите страницу приложения.'}, status_code=403)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def session_path(session_id: str):
        if not re.fullmatch(r'[0-9a-f]{32}', session_id):
            raise HTTPException(404, 'Сессия не найдена.')
        directory = data_root / session_id
        if not directory.is_dir():
            raise HTTPException(404, 'Сессия не найдена.')
        return directory

    @app.get('/api/status')
    def status():
        return {'version': '0.3.0', 'csrf_token': token, 'recording': recorder.snapshot(),
                'speech_recognition': recognizer_available(), 'speaker_diarization': False,
                'teams_join': 'operator_managed'}

    @app.get('/api/capabilities')
    def capabilities():
        return {'asr': recognizer_available(), 'analyzer': True, 'diarization': False,
                'live': True, 'join_mode': 'browser_assisted', 'summary_mode': 'rules',
                'summary_interval_seconds': 300, 'extensions': sorted(EXTENSIONS),
                'maxBytes': MAX_UPLOAD_BYTES, 'csrf_token': token}

    def ensure_recorder_idle():
        current = recorder.snapshot()
        if current and current['status'] in ('starting', 'recording', 'stopping'):
            raise ValueError('Сначала завершите текущую запись.')

    @app.get('/api/connection')
    def connection():
        return {'connection': bot.snapshot()}

    @app.post('/api/meetings/connect', status_code=201)
    def connect(body: ConnectRequest):
        if not body.acknowledged:
            raise HTTPException(400, 'Подтвердите готовность источника звука и уведомление участников.')
        try:
            with operation_lock:
                ensure_recorder_idle()
                uploads.ensure_idle()
                return bot.start(url=body.url, title=body.title, device_id=body.device_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post('/api/meetings/confirm')
    def confirm():
        try:
            return bot.confirm()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post('/api/meetings/disconnect')
    def disconnect():
        return {'connection': bot.stop()}

    @app.get('/api/devices')
    def devices():
        try:
            return {'devices': list_devices()}
        except Exception as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.post('/api/recordings/start', status_code=201)
    def start(body: StartRequest):
        if not body.acknowledged:
            raise HTTPException(400, 'Подтвердите, что источник звука готов и участники уведомлены о записи.')
        try:
            with operation_lock:
                bot.ensure_idle()
                uploads.ensure_idle()
                result = recorder.start(device_id=body.device_id, title=body.title.strip() or 'Совещание', platform=body.platform)
                transcription.start(result['id'])
                return result
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.post('/api/recordings/stop')
    def stop():
        result = recorder.stop()
        transcription.notify()
        return {'recording': result}

    @app.post('/api/teams/open')
    def teams(body: TeamsRequest):
        try:
            return open_guest_window(body.url)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except (OSError, RuntimeError) as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.get('/api/sessions')
    def sessions():
        items = []
        for path in sorted(data_root.glob('*/session.json'), reverse=True):
            try:
                items.append(json.loads(path.read_text(encoding='utf-8')))
            except (OSError, ValueError):
                continue
        return {'sessions': sorted(items, key=lambda s: s.get('created_at', ''), reverse=True)[:100]}

    @app.get('/api/sessions/{session_id}')
    def session(session_id: str):
        path = session_path(session_id) / 'session.json'
        if not path.is_file():
            raise HTTPException(404, 'Метаданные сессии не найдены.')
        return json.loads(path.read_text(encoding='utf-8'))

    def result_for(session_id):
        directory = session_path(session_id)
        meta = json.loads((directory / 'session.json').read_text(encoding='utf-8'))
        t = transcription.read(session_id)
        analysis = read_analysis(directory)
        active = meta['status'] in ('starting', 'recording', 'stopping')
        if meta['status'] in ('error', 'interrupted') or t['status'] in ('error', 'interrupted', 'unavailable'):
            status = 'partial' if t['segments'] else 'error'
        elif active:
            status = 'recording'
        elif meta['status'] in ('preparing', 'uploading') or t['status'] in ('processing', 'waiting'):
            status = 'processing'
        elif t['status'] == 'completed':
            status = 'ready'
        else:
            status = 'awaiting'
        chunks = meta.get('chunks', [])
        processed = sum(c['duration'] for c in chunks[:t.get('processed_chunks', 0)])
        return {'id': session_id, 'title': meta['title'], 'created_at': meta['created_at'],
                'source': meta.get('source'), 'platform': meta.get('platform'), 'status': status,
                'recording_status': meta['status'], 'transcription_status': t['status'],
                'duration_seconds': meta.get('duration_seconds', 0), 'processed_seconds': processed,
                'progress': min(100, round(100 * processed / max(.1, meta.get('duration_seconds', 0)))),
                'segments': t['segments'], 'analysis': analysis, 'metadata': meta.get('metadata', {}),
                'error': meta.get('error') or t.get('error'), 'warning': meta.get('warning'),
                'diarization': False, 'audio_url': f'/api/sessions/{session_id}/files/recording.wav',
                'revision': [t['revision'], analysis['revision'], meta['status'], t['status']]}

    @app.get('/api/sessions/{session_id}/result')
    def result(session_id: str):
        return result_for(session_id)

    @app.post('/api/sessions/{session_id}/transcribe')
    def transcribe_existing(session_id: str):
        meta = session(session_id)
        try:
            with operation_lock:
                ensure_recorder_idle()
                bot.ensure_idle()
                uploads.ensure_idle()
                if meta['status'] != 'completed' or transcription.read(session_id)['status'] not in ('not_started', 'unavailable'):
                    raise ValueError('Эту запись нельзя запустить повторно.')
                transcription.start(session_id)
            return {'id': session_id}
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get('/api/sessions/{session_id}/summary.txt')
    def summary_file(session_id: str):
        path = session_path(session_id) / 'summary.txt'
        if not path.is_file():
            raise HTTPException(404, 'Итоги ещё не сформированы.')
        return FileResponse(path, media_type='text/plain; charset=utf-8', filename='summary.txt')

    @app.post('/api/jobs', status_code=201)
    async def upload(request: Request, audio: UploadFile = File(...), metadata: str = Form('{}')):
        state = None
        reserved = False
        try:
            ext = (audio.filename or '').rsplit('.', 1)[-1].lower()
            if ext not in EXTENSIONS:
                raise HTTPException(400, 'Неподдерживаемый формат аудио.')
            try:
                meta = json.loads(metadata)
                if not isinstance(meta, dict):
                    raise ValueError()
                title = str(meta.get('title') or 'Аудиозапись').strip()[:180]
            except (ValueError, TypeError):
                raise HTTPException(400, 'Неверные данные совещания.') from None
            request_id = request.headers.get('idempotency-key', '')[:128]
            if request_id:
                for saved in data_root.glob('*/session.json'):
                    candidate = json.loads(saved.read_text(encoding='utf-8'))
                    if candidate.get('metadata', {}).get('request_id') == request_id:
                        return {'id': candidate['id']}
            with operation_lock:
                ensure_recorder_idle()
                bot.ensure_idle()
                uploads.reserve()
                reserved = True
            if shutil.disk_usage(data_root).free < 512 * 1024 * 1024:
                raise HTTPException(409, 'Недостаточно свободного места на диске.')
            state = uploads.create(title, audio.filename, {**meta, 'request_id': request_id})
            path = data_root / state['id'] / ('input.' + ext)
            size = 0
            with path.open('wb') as target:
                while data := await audio.read(1024 * 1024):
                    size += len(data)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, 'Файл превышает 200 МБ.')
                    target.write(data)
            if not size:
                raise HTTPException(400, 'Аудиофайл пуст.')
            uploads.start(state, path)
            reserved = False
            return {'id': state['id']}
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception:
            if state:
                from .recorder import save_json
                state.update(status='error', error='Загрузка файла прервана.')
                save_json(data_root / state['id'] / 'session.json', state)
            raise
        finally:
            if reserved:
                uploads.release()
            await audio.close()

    @app.get('/api/jobs/{session_id}')
    def job(session_id: str):
        result = result_for(session_id)
        analysis = result['analysis']
        return {'id': session_id, 'status': {'ready': 'completed', 'error': 'failed'}.get(result['status'], result['status']),
                'stage': 'transcription', 'progress': result['progress'], 'error': result['error'],
                'result': {'segments': result['segments'], 'summary': analysis['summary'], 'tasks': analysis['tasks']}}

    @app.post('/api/analyze')
    def analyze(payload: dict):
        try:
            segments = payload.get('segments', payload.get('transcript', []))
            return {'segments': segments, **analyze_segments(segments)}
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(422, 'Неверный формат реплик.') from exc

    @app.get('/api/sessions/{session_id}/transcript')
    def transcript(session_id: str, after: int = Query(default=0, ge=0)):
        session_path(session_id)
        return transcription.read(session_id, after=after)

    @app.get('/api/sessions/{session_id}/transcript.txt')
    def transcript_file(session_id: str):
        path = session_path(session_id) / 'transcript.txt'
        if not path.is_file():
            raise HTTPException(404, 'Транскрипт ещё не готов.')
        return FileResponse(path, media_type='text/plain; charset=utf-8', filename='transcript.txt')

    @app.get('/api/sessions/{session_id}/files/{filename}')
    def audio(session_id: str, filename: str):
        directory = session_path(session_id)
        if filename != 'recording.wav' and not re.fullmatch(r'chunk-\d{5}\.wav', filename):
            raise HTTPException(404, 'Файл не найден.')
        current = recorder.snapshot()
        if (filename == 'recording.wav' and current and current['id'] == session_id
                and current['status'] in ('starting', 'recording', 'stopping')):
            raise HTTPException(409, 'Полная запись доступна после остановки. Готовые фрагменты доступны сейчас.')
        path = directory / filename
        if not path.is_file():
            raise HTTPException(404, 'Файл не найден.')
        return FileResponse(path, media_type='audio/wav', filename=filename)

    app.mount('/', StaticFiles(directory=ROOT / 'ui', html=True), name='ui')
    return app
