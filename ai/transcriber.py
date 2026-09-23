"""Local speech-to-text adapter based on faster-whisper.

The backend calls this module for each saved audio chunk.  It deliberately
does not capture Windows audio and does not identify people by voice: those
are separate concerns owned by the backend and diarization layer.
"""

from __future__ import annotations

import argparse
import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


DEFAULT_SPEAKER = "speaker-unknown"


class TranscriptionError(RuntimeError):
    """Raised when the local speech recognition runtime is unavailable."""


@lru_cache(maxsize=1)
def _load_whisper_model(model_size: str, device: str) -> Any:
    """Load the selected Whisper model only when transcription is requested."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise TranscriptionError(
            "Не установлен faster-whisper. Выполните: py -m pip install -r ai/requirements.txt"
        ) from error

    compute_type = "float16" if device == "cuda" else "int8"
    try:
        return WhisperModel(model_size, device=device, compute_type=compute_type,
                            download_root=str(Path(__file__).resolve().parent.parent / 'models'))
    except Exception as error:  # Library errors depend on CUDA and model download state.
        hint = "Проверьте CUDA-драйвер" if device == "cuda" else "Проверьте интернет и свободное место для модели"
        raise TranscriptionError(f"Не удалось загрузить модель Whisper ({hint}): {error}") from error


def normalize_segments(raw_segments: Iterable[Any], speaker: str = DEFAULT_SPEAKER) -> list[dict[str, Any]]:
    """Convert faster-whisper segments to the transcript contract used by the project."""
    transcript: list[dict[str, Any]] = []
    for segment in raw_segments:
        text = str(getattr(segment, "text", "")).strip()
        if not text:
            continue
        transcript.append(
            {
                "speaker": speaker,
                "start": round(float(getattr(segment, "start", 0.0)), 2),
                "end": round(float(getattr(segment, "end", 0.0)), 2),
                "text": text,
            }
        )
    return transcript


def transcribe_chunk(
    audio_path: str | Path,
    *,
    model_size: str = "base",
    device: str = "cpu",
    speaker: str = DEFAULT_SPEAKER,
) -> list[dict[str, Any]]:
    """Transcribe one local audio file or a 10–15-second chunk.

    Keep ``language=None`` for Russian, Kazakh and mixed speech.  The caller
    sends each result to the UI immediately and appends it to the meeting
    transcript.  Time offsets are relative to the supplied chunk.
    """
    path = Path(audio_path)
    if not path.is_file():
        raise TranscriptionError(f"Аудиофайл не найден: {path}")
    if device not in {"cpu", "cuda"}:
        raise ValueError("device должен быть 'cpu' или 'cuda'")

    model = _load_whisper_model(model_size, device)
    try:
        raw_segments, _info = model.transcribe(
            str(path),
            task="transcribe",
            language=None,
            beam_size=3,
            vad_filter=True,
            condition_on_previous_text=False,
            chunk_length=15,
        )
        return normalize_segments(raw_segments, speaker=speaker)
    except Exception as error:
        raise TranscriptionError(f"Не удалось распознать аудио {path.name}: {error}") from error


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальная транскрипция аудио через faster-whisper")
    parser.add_argument("input", type=Path, help="Путь к MP3, WAV, M4A или другому аудиофайлу")
    parser.add_argument("output", type=Path, help="Куда записать JSON с segments")
    parser.add_argument("--model", default="base", help="Whisper-модель: base (по умолчанию) или small")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()

    print(f"Загружаем Whisper {args.model} на {args.device}; первый запуск скачает модель.")
    print(f"Распознаём: {args.input.name}")
    result = {"segments": transcribe_chunk(args.input, model_size=args.model, device=args.device)}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8-sig")
    print(f"Готово: {len(result['segments'])} сегментов записано в {args.output}")


if __name__ == "__main__":
    main()
