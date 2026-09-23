"""Rank meeting decisions and facts, preserving their original wording."""
import re

SIGNAL = re.compile(r"решил|решено|решили|согласовали|утвердили|договорились|итог|"
                    r"проблем|риск|задерж|бюджет|обсудили|снижен|рост|увелич|"
                    r"шешім|келістік|мәселе|талқыла", re.IGNORECASE)
CEREMONY = re.compile(r"^(?:коллеги[, ]|добрый день|здравствуйте|спасибо|прошу коротко|"
                     r"начинаем|вам слово|құрметті|сәлем|рақмет)|вам слово", re.IGNORECASE)


def summarize(segments, tasks):
    candidates = []
    known = set()
    for index, segment in enumerate(segments):
        for sentence in re.split(r"(?<=[.!?])\s+", segment.text):
            sentence = sentence.strip()
            if not sentence or CEREMONY.search(sentence) or re.search(r'\b\d+\.$', sentence):
                continue
            score = len(SIGNAL.findall(sentence)) * 3
            if not score or sentence.casefold() in known:
                continue
            # Assignment quotes are represented separately, with owner/deadline.
            if any(sentence in task.evidence['quote'] for task in tasks):
                continue
            known.add(sentence.casefold())
            candidates.append((score, index, sentence))
    chosen = sorted(sorted(candidates, key=lambda x: (-x[0], x[1]))[:3], key=lambda x: x[1])
    points = [sentence for _, _, sentence in chosen]
    ranked_tasks = sorted(tasks, key=lambda task: task.requires_review)
    for task in ranked_tasks[:5]:
        owner = task.responsible or 'не указан'
        deadline = task.deadline or 'не указан'
        points.append(f'{task.title}. Ответственный: {owner}. Срок: {deadline}.')
    text = ' '.join(points) if points else 'Содержательные итоги автоматически не выделены. Проверьте транскрипт.'
    return {'text': text, 'key_points': points, 'method': 'extractive',
            'requires_review': True, 'segment_count': len(segments), 'task_count': len(tasks)}
