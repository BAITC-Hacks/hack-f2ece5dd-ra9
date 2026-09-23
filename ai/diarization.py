"""Offline speaker diarization of a completed meeting (not independent chunks)."""
from __future__ import annotations

import os
from pathlib import Path


def diarize_recording(audio_path, model_path):
    """Load an explicitly downloaded local Community-1 pipeline; never a cloud ID."""
    path = Path(model_path).resolve()
    if not (path / 'config.yaml').is_file():
        raise ValueError('Нет локальной модели диаризации с config.yaml. См. ai/README.md.')
    os.environ['PYANNOTE_METRICS_ENABLED'] = '0'
    os.environ['HF_HUB_OFFLINE'] = '1'
    from pyannote.audio import Pipeline
    from faster_whisper.audio import decode_audio
    import torch

    # PyAV decoding avoids a separate FFmpeg/TorchCodec installation on Windows.
    samples = decode_audio(str(audio_path), sampling_rate=16000)
    pipeline = Pipeline.from_pretrained(str(path))
    output = pipeline({'waveform': torch.from_numpy(samples).unsqueeze(0), 'sample_rate': 16000})
    return [{'start': float(turn.start), 'end': float(turn.end), 'speaker_id': str(speaker)}
            for turn, speaker in output.exclusive_speaker_diarization]


def assign_speakers(segments, turns):
    """Keep text/times intact; ambiguous multi-speaker segments remain unknown."""
    labels = {}
    for turn in sorted(turns, key=lambda item: item['start']):
        labels.setdefault(turn['speaker_id'], f'speaker-{len(labels) + 1}')
    result = []
    for segment in segments:
        start, end = float(segment['start']), float(segment['end'])
        overlap = {}
        for turn in turns:
            duration = max(0.0, min(end, turn['end']) - max(start, turn['start']))
            if duration:
                label = labels[turn['speaker_id']]
                overlap[label] = overlap.get(label, 0.0) + duration
        ordered = sorted(overlap.items(), key=lambda item: -item[1])
        speaker = 'speaker-unknown'
        # A timestamp interval is not proof that all its words share one voice.
        if ordered and end > start and ordered[0][1] / (end - start) >= .8:
            speaker = ordered[0][0]
        result.append({**segment, 'speaker_id': speaker, 'speaker': speaker,
                       'speaker_requires_review': speaker == 'speaker-unknown'})
    return result
