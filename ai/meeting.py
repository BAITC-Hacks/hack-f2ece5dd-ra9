"""Build a final protocol from backend or CLI transcript segments."""
from .analyzer import analyse, build_summary, ActionItem


def build_meeting(segments, *, title='Совещание', speaker_names=None, diarization_status='not_configured', warnings=None):
    names = speaker_names or {}
    normalized = [{**s, 'speaker': s.get('speaker_id', s.get('speaker')) or 'speaker-unknown'} for s in segments]
    known_ids = {s['speaker'] for s in normalized} - {'speaker-unknown'}
    analysis = analyse({'segments': normalized})
    for task in analysis['tasks']:
        owner = task['responsible']
        owner_id = None
        if owner in known_ids:
            owner_id = owner
        elif owner:
            matches = [sid for sid, name in names.items()
                       if name.casefold() == owner.casefold() or name.casefold().startswith(owner.casefold() + ' ')]
            if len(matches) == 1:
                owner_id = matches[0]
        task['responsible_id'] = owner_id
        if owner_id:
            task['responsible'] = names.get(owner_id, owner)
        task['requires_review'] = task['requires_review'] or owner_id not in names
    analysis['summary'] = build_summary({'segments': normalized}, [
        ActionItem(**{key: task[key] for key in ActionItem.__dataclass_fields__}) for task in analysis['tasks']])
    return {'schema_version': 1, 'title': title, 'transcript': {'segments': normalized},
            'speaker_names': names, 'diarization_status': diarization_status,
            'warnings': warnings or [], 'summary': analysis['summary'], 'tasks': analysis['tasks']}


def finalize_recording(audio_path, segments, *, title='Совещание', model_path=None):
    warnings = []
    status = 'not_configured'
    if model_path:
        from .diarization import diarize_recording, assign_speakers
        try:
            turns = diarize_recording(audio_path, model_path)
            segments = assign_speakers(segments, turns)
            status = 'completed'
        except Exception as error:
            status = 'error'
            warnings.append(f'Диаризация не выполнена: {error}')
    else:
        warnings.append('Диаризация не настроена. Говорящие не определены.')
    return build_meeting(segments, title=title, diarization_status=status, warnings=warnings)
