"""End-of-meeting pipeline: local audio -> transcript -> summary and tasks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ai.analyzer import analyse
from ai.transcriber import DEFAULT_SPEAKER, transcribe_chunk


def process_recording(
    audio_path: str | Path,
    *,
    model_size: str = "base",
    device: str = "cpu",
    speaker: str = DEFAULT_SPEAKER,
) -> dict[str, Any]:
    """Return all demo data needed after one meeting recording.

    The caller can save the result as one local JSON file or send its
    ``transcript``, ``summary`` and ``tasks`` fields to the UI separately.
    """
    segments = transcribe_chunk(
        audio_path,
        model_size=model_size,
        device=device,
        speaker=speaker,
    )
    analysis = analyse({"segments": segments})
    return {
        "schema_version": 1,
        "transcript": {"segments": segments},
        "summary": analysis["summary"],
        "tasks": analysis["tasks"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальный протокол совещания из аудиозаписи")
    parser.add_argument("input", type=Path, help="Запись совещания: MP3, WAV, M4A и др.")
    parser.add_argument("output", type=Path, help="Итоговый JSON с транскриптом, саммари и задачами")
    parser.add_argument("--model", default="base", help="Whisper-модель: base (по умолчанию) или small")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()

    print(f"Обрабатываем запись: {args.input.name}")
    result = process_recording(args.input, model_size=args.model, device=args.device)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8-sig")
    print(f"Готово: {len(result['transcript']['segments'])} реплик, {len(result['tasks'])} поручений.")


if __name__ == "__main__":
    main()
