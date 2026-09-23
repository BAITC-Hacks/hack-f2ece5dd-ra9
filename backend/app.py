"""Local-only API and UI. Start: python -m backend --port 8765."""
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .recorder import Recorder, list_devices
from .teams import open_guest_window
from .transcription import TranscriptManager, recognizer_available

ROOT = Path(__file__).resolve().parent.parent


class StartRequest(BaseModel):
    device_id: int = Field(ge=0)
    title: str = Field(default='Совещание', min_length=1, max_length=100)
    platform: str = Field(default='Teams', pattern=r'^(Teams|Zoom|Local)$')
    acknowledged: bool = False


class TeamsRequest(BaseModel):
    url: str = Field(min_length=10, max_length=4096)


class NamesRequest(BaseModel):
    names: dict[str, str] = Field(default_factory=dict, max_length=100)


def create_app(data_root: Path | None = None, recorder=None, transcription=None):
    data_root = data_root or ROOT / 'sessions'
    recorder = recorder or Recorder(data_root)
    transcription = transcription or TranscriptManager(data_root)
    token = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(app):
        yield
        recorder.stop()

    app = FastAPI(title='AI Протоколист — запись и транскрипция', version='0.3.0', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])

    @app.middleware('http')
    async def guard(request: Request, call_next):
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
                'speech_recognition': recognizer_available(),
                'speaker_diarization': bool(os.environ.get('DIARIZATION_MODEL_PATH')),
                'teams_join': 'operator_managed'}

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
            transcription.ensure_idle()
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

    @app.post('/api/recordings/upload', status_code=202)
    async def upload(request: Request, filename: str, title: str = 'Совещание'):
        suffix = Path(filename).suffix.lower()
        if suffix not in ('.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.webm', '.mp4'):
            raise HTTPException(422, 'Неподдерживаемый формат аудио.')
        current = recorder.snapshot()
        if current and current['status'] in ('starting', 'recording', 'stopping'):
            raise HTTPException(409, 'Сначала остановите текущую запись.')
        data_root.mkdir(parents=True, exist_ok=True)
        path = None
        try:
            transcription.ensure_idle()
            size = 0
            with tempfile.NamedTemporaryFile(dir=data_root, suffix=suffix, delete=False) as stream:
                path = Path(stream.name)
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 200 * 1024 * 1024:
                        raise HTTPException(413, 'Файл больше 200 МБ.')
                    stream.write(chunk)
            if not size:
                raise HTTPException(422, 'Аудиофайл пуст.')
            return transcription.import_audio(path, title.strip()[:100] or 'Совещание')
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        finally:
            if path is not None:
                path.unlink(missing_ok=True)

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

    def read_result(session_id):
        path = session_path(session_id) / 'result.json'
        if not path.is_file():
            raise HTTPException(409, 'Итоги ещё не готовы. Дождитесь завершения распознавания.')
        return json.loads(path.read_text(encoding='utf-8'))

    @app.get('/api/sessions/{session_id}/result')
    def result(session_id: str):
        return read_result(session_id)

    @app.post('/api/sessions/{session_id}/speakers')
    def speaker_names(session_id: str, body: NamesRequest):
        from ai.meeting import build_meeting
        from .recorder import save_json
        meeting = read_result(session_id)
        allowed = {s.get('speaker_id', s.get('speaker')) for s in meeting['transcript']['segments']}
        allowed.discard('speaker-unknown')
        if any(sid not in allowed or not name.strip() or len(name) > 100 for sid, name in body.names.items()):
            raise HTTPException(422, 'Нужны имена до 100 символов для существующих определённых говорящих.')
        updated = build_meeting(meeting['transcript']['segments'], title=meeting['title'],
                                speaker_names={sid: name.strip() for sid, name in body.names.items()},
                                diarization_status=meeting['diarization_status'], warnings=meeting['warnings'])
        save_json(session_path(session_id) / 'result.json', updated)
        return updated

    @app.get('/api/sessions/{session_id}/protocol.docx')
    def protocol(session_id: str):
        from ai.report import create_docx
        return Response(create_docx(read_result(session_id)),
                        media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        headers={'Content-Disposition': 'attachment; filename="protocol.docx"'})

    app.mount('/', StaticFiles(directory=ROOT / 'ui', html=True), name='ui')
    return app
