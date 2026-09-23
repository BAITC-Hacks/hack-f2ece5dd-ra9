"""Process completed meeting WAV chunks without blocking audio capture or HTTP."""
from __future__ import annotations

from datetime import datetime, timezone
import importlib
import json
import math
import os
from pathlib import Path
import re
import threading
import uuid
from typing import Callable

from .recorder import save_json

TERMINAL_RECORDING_STATES = {'completed', 'error', 'interrupted'}
SPEAKER_ID = re.compile(r'[A-Za-z0-9_-]{1,64}\Z')


def recognizer_available() -> bool:
    """The module is supplied by the speech-recognition developer."""
    return (Path(__file__).resolve().parent.parent / 'speech' / 'recognizer.py').is_file()


def load_recognizer(session_id: str):
    module = importlib.import_module('speech.recognizer')
    return module.create_recognizer(session_id)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _initial_state(session_id: str) -> dict:
    return {
        'schema_version': 1, 'session_id': session_id, 'status': 'waiting',
        'revision': 0, 'processed_chunks': 0, 'segments': [], 'error': None,
        'updated_at': _now(),
    }


def _normalize(raw, chunk: dict) -> list[dict]:
    """Accept only final, absolute-time diarized segments for this chunk."""
    if not isinstance(raw, list):
        raise ValueError('Модуль распознавания должен вернуть список реплик.')
    start_limit = float(chunk['start'])
    end_limit = start_limit + float(chunk['duration'])
    segments = []
    for position, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError('Каждая реплика должна быть объектом.')
        speaker = item.get('speaker_id')
        if not isinstance(speaker, str) or not SPEAKER_ID.fullmatch(speaker):
            raise ValueError('Для каждой реплики нужен устойчивый speaker_id.')
        text = item.get('text')
        if not isinstance(text, str) or not text.strip():
            raise ValueError('Распознанная реплика должна содержать текст.')
        try:
            start = float(item['start'])
            end = float(item['end'])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError('Таймкоды реплики должны быть числами в секундах.') from exc
        if (not math.isfinite(start) or not math.isfinite(end) or start > end
                or start < max(0, start_limit - .05) or end > end_limit + .05):
            raise ValueError('Таймкоды должны отсчитываться от начала встречи и находиться внутри WAV-фрагмента.')
        segments.append({
            'id': f"seg-{chunk['index']:05d}-{position:03d}",
            'speaker_id': speaker, 'start': round(start, 3), 'end': round(end, 3),
            'text': text.strip(), 'is_final': True,
        })
    return sorted(segments, key=lambda segment: (segment['start'], segment['end'], segment['id']))


class TranscriptManager:
    """One sequential transcription worker per meeting, persisted after every chunk."""

    def __init__(self, root: Path, recognizer_factory: Callable | None = None):
        self.root = root
        self.factory = recognizer_factory or load_recognizer
        self.lock = threading.RLock()
        self.threads: dict[str, threading.Thread] = {}
        self.wake = threading.Event()
        for path in root.glob('*/transcript.json'):
            try:
                state = json.loads(path.read_text(encoding='utf-8'))
                if state.get('status') in ('waiting', 'processing', 'finalizing'):
                    state['status'] = 'interrupted'
                    state['error'] = 'Сервер был перезапущен до завершения распознавания.'
                    state['updated_at'] = _now()
                    save_json(path, state)
            except (OSError, ValueError):
                continue

    def _path(self, session_id: str) -> Path:
        return self.root / session_id / 'transcript.json'

    def _read_full(self, session_id: str) -> dict:
        path = self._path(session_id)
        if not path.is_file():
            return {**_initial_state(session_id), 'status': 'not_started'}
        return json.loads(path.read_text(encoding='utf-8'))

    def read(self, session_id: str, after: int = 0) -> dict:
        with self.lock:
            state = self._read_full(session_id)
        segments = state['segments']
        cursor = len(segments)
        return {**state, 'segments': segments[min(after, cursor):], 'next_cursor': cursor}

    def _save(self, session_id: str, state: dict):
        state['updated_at'] = _now()
        save_json(self._path(session_id), state)

    def start(self, session_id: str):
        with self.lock:
            worker = self.threads.get(session_id)
            if worker and worker.is_alive():
                return
            directory = self.root / session_id
            directory.mkdir(parents=True, exist_ok=True)
            if not self._path(session_id).is_file():
                self._save(session_id, _initial_state(session_id))
            worker = threading.Thread(target=self._run, args=(session_id,), daemon=True,
                                      name=f'transcript-{session_id[:8]}')
            self.threads[session_id] = worker
            worker.start()

    def ensure_idle(self):
        with self.lock:
            if any(worker.is_alive() for worker in self.threads.values()):
                raise ValueError('Дождитесь завершения распознавания предыдущей встречи.')

    def import_audio(self, source: Path, title: str):
        """Decode an uploaded file locally, then use the same finalization path."""
        session_id = uuid.uuid4().hex
        directory = self.root / session_id
        with self.lock:
            self.ensure_idle()
            directory.mkdir(parents=True)
            saved_source = directory / ('source' + source.suffix)
            source.replace(saved_source)
            self._save(session_id, {**_initial_state(session_id), 'status': 'processing'})
            metadata = {'schema_version': 1, 'id': session_id, 'title': title, 'platform': 'Local',
                        'source': 'upload', 'status': 'processing', 'duration_seconds': 0,
                        'created_at': _now(), 'chunks': []}
            save_json(directory / 'session.json', metadata)

            def process():
                try:
                    import wave
                    import numpy as np
                    from faster_whisper.audio import decode_audio
                    samples = decode_audio(str(saved_source), sampling_rate=16000)
                    if not len(samples):
                        raise ValueError('В файле нет аудио.')
                    if len(samples) > 16000 * 7200:
                        raise ValueError('Запись длиннее двух часов.')
                    with wave.open(str(directory / 'recording.wav'), 'wb') as audio:
                        audio.setnchannels(1)
                        audio.setsampwidth(2)
                        audio.setframerate(16000)
                        audio.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
                    duration = len(samples) / 16000
                    metadata.update(status='completed', duration_seconds=duration,
                                    chunks=[{'index': 0, 'file': 'recording.wav', 'start': 0, 'duration': duration}])
                    save_json(directory / 'session.json', metadata)
                    self._run(session_id)
                except Exception as error:
                    metadata.update(status='error', error=str(error))
                    save_json(directory / 'session.json', metadata)
                    with self.lock:
                        self._save(session_id, {**_initial_state(session_id), 'status': 'error', 'error': str(error)})
            worker = threading.Thread(target=process, daemon=True, name=f'import-{session_id[:8]}')
            self.threads[session_id] = worker
            worker.start()
        return metadata

    def notify(self):
        self.wake.set()

    def _publish_text(self, session_id: str, segments: list[dict]):
        path = self.root / session_id / 'transcript.txt'
        temporary = path.with_suffix('.tmp')
        lines = [f"[{segment['start']:.2f}–{segment['end']:.2f}] "
                 f"{segment['speaker_id']}: {segment['text']}" for segment in segments]
        temporary.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
        temporary.replace(path)

    def _run(self, session_id: str):
        recognizer = None
        try:
            if self.factory is load_recognizer and not recognizer_available():
                with self.lock:
                    state = self._read_full(session_id)
                    state['status'] = 'unavailable'
                    state['error'] = 'Модуль speech/recognizer.py ещё не подключён.'
                    self._save(session_id, state)
                return
            recognizer = self.factory(session_id)
            if not callable(getattr(recognizer, 'transcribe_chunk', None)):
                raise TypeError('Модуль должен предоставить метод transcribe_chunk(wav_path, *, start_seconds).')
            while True:
                metadata_path = self.root / session_id / 'session.json'
                if not metadata_path.is_file():
                    raise FileNotFoundError('Метаданные аудиозаписи не найдены.')
                metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
                with self.lock:
                    state = self._read_full(session_id)
                    processed = state['processed_chunks']
                chunks = metadata.get('chunks', [])
                for chunk in chunks[processed:]:
                    if chunk['index'] != processed:
                        raise ValueError('Нарушен порядок WAV-фрагментов.')
                    path = self.root / session_id / chunk['file']
                    if not path.is_file():
                        raise FileNotFoundError(f"Фрагмент {chunk['file']} отсутствует.")
                    with self.lock:
                        state['status'] = 'processing'
                        self._save(session_id, state)
                    raw = recognizer.transcribe_chunk(path, start_seconds=float(chunk['start']))
                    segments = _normalize(raw, chunk)
                    with self.lock:
                        state['segments'].extend(segments)
                        state['processed_chunks'] += 1
                        state['revision'] += 1
                        state['status'] = 'waiting'
                        self._save(session_id, state)
                        self._publish_text(session_id, state['segments'])
                    processed += 1
                if metadata.get('status') in TERMINAL_RECORDING_STATES and processed == len(chunks):
                    if metadata['status'] == 'completed':
                        from ai.meeting import finalize_recording
                        with self.lock:
                            state['status'] = 'finalizing'
                            self._save(session_id, state)
                        result = finalize_recording(
                            self.root / session_id / 'recording.wav', state['segments'],
                            title=metadata.get('title', 'Совещание'),
                            model_path=os.environ.get('DIARIZATION_MODEL_PATH'))
                        save_json(self.root / session_id / 'result.json', result)
                    with self.lock:
                        state['status'] = 'completed' if metadata['status'] == 'completed' else metadata['status']
                        self._save(session_id, state)
                        self._publish_text(session_id, state['segments'])
                    return
                self.wake.wait(.25)
                self.wake.clear()
        except Exception as exc:
            with self.lock:
                state = self._read_full(session_id)
                state.update(status='error', error=f'{type(exc).__name__}: {exc}')
                self._save(session_id, state)
        finally:
            if recognizer is not None and callable(getattr(recognizer, 'close', None)):
                try:
                    recognizer.close()
                except Exception:
                    pass
