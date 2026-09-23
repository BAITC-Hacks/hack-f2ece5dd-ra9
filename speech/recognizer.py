"""Turn Jan's chunk-relative transcript into the backend's meeting timeline."""
import os
from pathlib import Path
import wave

from ai.transcriber import transcribe_chunk


class Recognizer:
    def __init__(self):
        self.model = os.environ.get('WHISPER_MODEL', 'base')
        self.device = os.environ.get('WHISPER_DEVICE', 'cpu')

    def transcribe_chunk(self, wav_path: Path, *, start_seconds: float) -> list[dict]:
        with wave.open(str(wav_path), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
        segments = transcribe_chunk(wav_path, model_size=self.model, device=self.device,
                                    speaker='Не определён')
        result = []
        for segment in segments:
            # Whisper can place the last timestamp into its padded audio window.
            start = min(duration, max(0.0, float(segment['start'])))
            end = min(duration, max(0.0, float(segment['end'])))
            if end <= start:
                continue
            result.append({
                'speaker_id': 'speaker-unknown',
                'start': start_seconds + start, 'end': start_seconds + end,
                'text': segment['text'],
            })
        return result


def create_recognizer(session_id: str):
    return Recognizer()
