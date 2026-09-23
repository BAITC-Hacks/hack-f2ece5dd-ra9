"""Decode an uploaded recording to the same WAV chunks used by live capture."""
from pathlib import Path
import threading
import uuid

from .recorder import AudioFiles, MAX_BYTES, MAX_SECONDS, save_json, utc_now

EXTENSIONS = {'mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac', 'webm', 'mp4'}
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


class UploadManager:
    def __init__(self, root: Path, transcription):
        self.root, self.transcription = root, transcription
        self.lock = threading.RLock()
        self.worker = None
        self.reserved = False

    def ensure_idle(self):
        with self.lock:
            if self.reserved or (self.worker and self.worker.is_alive()):
                raise ValueError('Дождитесь обработки предыдущей загрузки.')
            self.transcription.ensure_idle()

    def reserve(self):
        with self.lock:
            self.ensure_idle()
            self.reserved = True

    def release(self):
        with self.lock:
            self.reserved = False

    def create(self, title, filename, metadata):
        session_id = uuid.uuid4().hex
        directory = self.root / session_id
        directory.mkdir(parents=True)
        state = {'schema_version': 1, 'id': session_id, 'title': title, 'platform': 'Local',
                 'source': 'audio_upload', 'status': 'uploading', 'created_at': utc_now(),
                 'audio_file': 'recording.wav', 'original_name': Path(filename).name,
                 'sample_rate': 16000, 'channels': 1, 'sample_width': 2,
                 'duration_seconds': 0, 'elapsed_seconds': 0, 'chunks': [], 'level': 0,
                 'error': None, 'warning': None, 'metadata': metadata}
        save_json(directory / 'session.json', state)
        return state

    def start(self, state, path):
        with self.lock:
            self.reserved = False
            self.worker = threading.Thread(target=self._decode, args=(state, path), daemon=True)
            self.worker.start()

    def _decode(self, state, path):
        import av
        directory = self.root / state['id']
        files = None
        try:
            state['status'] = 'preparing'
            save_json(directory / 'session.json', state)
            files = AudioFiles(directory, 16000, 1)
            with av.open(str(path)) as container:
                if not container.streams.audio:
                    raise ValueError('В файле нет аудиодорожки.')
                resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
                for frame in container.decode(audio=0):
                    for converted in resampler.resample(frame):
                        files.write(converted.to_ndarray().tobytes())
                    if files.frames > MAX_SECONDS * 16000 or files.frames * 2 > MAX_BYTES:
                        raise ValueError('Запись превышает лимит 2 часа или 1 ГБ PCM.')
                for converted in resampler.resample(None):
                    files.write(converted.to_ndarray().tobytes())
            files.close()
            state.update(status='completed', chunks=files.chunks, duration_seconds=files.frames / 16000,
                         elapsed_seconds=files.frames / 16000, stopped_at=utc_now())
            if not files.frames:
                raise ValueError('Аудиодорожка пуста.')
            save_json(directory / 'session.json', state)
            self.transcription.start(state['id'])
        except Exception as exc:
            if files:
                try:
                    files.close()
                except Exception:
                    pass
            state.update(status='error', error=f'Не удалось обработать аудио: {exc}')
            save_json(directory / 'session.json', state)
