"""Durable five-minute snapshots and final analysis of recognized speech."""
import hashlib
import json
from pathlib import Path

from ai.analyzer import analyse
from .recorder import save_json, utc_now

INTERVAL_SECONDS = 300


def empty_analysis():
    return {'revision': 0, 'snapshots': [], 'tasks': [], 'summary': {'text': '', 'key_points': []},
            'through_seconds': 0, 'final': False, 'error': None}


def read_analysis(directory: Path):
    path = directory / 'analysis.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else empty_analysis()


def analyze_segments(segments):
    payload = {'segments': [{'speaker': s.get('speaker', s.get('speaker_id', 'speaker-unknown')),
                             'start': s['start'], 'end': s['end'], 'text': s['text']} for s in segments]}
    result = analyse(payload)
    for task in result['tasks']:
        owner = task.get('responsible')
        if owner and (owner.lower().startswith(('speaker-', 'спикер', 'не определ'))
                      or owner.lower() in ('не назначен', 'не указано', 'не указан')):
            task['responsible'] = None
        task['requires_review'] = not task.get('responsible') or not task.get('deadline')
        identity = [task['title'].casefold(), task.get('responsible'), task.get('deadline'),
                    task.get('evidence', {}).get('start')]
        task['id'] = 'task-' + hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:16]
    return result


def update_analysis(directory: Path, segments: list, through_seconds: float, *, final=False):
    state = read_analysis(directory)
    if state['final']:
        return state
    last_periodic = max((s['through_seconds'] for s in state['snapshots'] if s['kind'] == 'periodic'), default=0)
    boundaries = list(range(int(last_periodic) + INTERVAL_SECONDS, int(through_seconds) + 1, INTERVAL_SECONDS))
    for boundary in boundaries:
        selected = [s for s in segments if float(s['end']) <= boundary + .05]
        result = analyze_segments(selected)
        state['snapshots'].append({'id': f'periodic-{boundary}', 'kind': 'periodic',
                                  'through_seconds': boundary, 'created_at': utc_now(), **result})
        state.update(summary=result['summary'], tasks=result['tasks'], through_seconds=boundary)
    if final:
        result = analyze_segments(segments)
        state['snapshots'].append({'id': 'final', 'kind': 'final', 'through_seconds': through_seconds,
                                  'created_at': utc_now(), **result})
        state.update(summary=result['summary'], tasks=result['tasks'], through_seconds=through_seconds, final=True)
    if boundaries or final:
        state['revision'] += 1
        save_json(directory / 'analysis.json', state)
        lines = [state['summary']['text'], *state['summary'].get('key_points', []), '', 'Поручения:']
        for task in state['tasks']:
            lines.append(f"- {task['title']} | Для: {task.get('responsible') or 'не указан'} | Срок: {task.get('deadline') or 'не указан'}")
        temporary = directory / 'summary.txt.tmp'
        temporary.write_text('\n'.join(lines), encoding='utf-8')
        temporary.replace(directory / 'summary.txt')
    return state
