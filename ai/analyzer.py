"""Extract a short summary and action items from a meeting transcript.

The module uses only Python's standard library. It is deliberately independent
from the web UI and audio-recognition stack: the backend gives it transcript
segments and receives JSON that can be rendered by any client.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

NAME_WORD = r"[А-ЯӘІҢҒҮҰҚӨҺ][а-яәіңғүұқөһ-]+"
PERSON_NAME = rf"{NAME_WORD}(?:\s+{NAME_WORD}){{0,2}}"

ACTION_RE = re.compile(
    r"\b(подготовить|провести|разработать|согласовать|организовать|проверить|"
    r"найти|предоставить|зафиксировать|доложить|обновить|разобраться|запросить|"
    r"направить|выставить|привлечь|сделать|дайындау|өткізу|келісу|тексеру|"
    r"жолдау|ұсыну|бекіту|подготовь|проверь|проведи|согласуй|организуй|"
    r"найди|предоставь|зафиксируй|доложи|обнови|разберись|запроси|направь|"
    r"выставь|привлеки|дайында\w*|жаса\w*|өткіз\w*|тексер\w*|келіс\w*|"
    r"ұсын\w*|бекіт\w*|орында\w*|жібер\w*|представить|представь|"
    r"сделаю|подготовлю|проведу|проверю|организую|свяжитесь|проведите|проверьте)\b",
    re.IGNORECASE,
)
DEADLINE_RE = re.compile(
    r"\b(?:до|к|на|в течение)\s+(?:завтра|сегодня|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|"
    r"сентября|октября|ноября|декабря)|конца\s+недели|пятницы|среды|четверга|"
    r"следующ(?:ей|ую)\s+недел[еи]|текущ(?:ей|ую)\s+недел[еи]|\d+\s+(?:дн(?:я|ей)|недел[ьи]))\b|"
    r"\b(?:завтра|сегодня|на следующей неделе|на этой неделе|в течение\s+\w+\s+недель)\b|"
    r"\b(?:ертеңге дейін|келесі аптада|осы аптада|жұмаға дейін|сәрсенбіге дейін|"
    r"\d{1,2}\s+[А-Яа-яӘәІіҢңҒғҮүҰұҚқӨөҺһ-]+ға дейін)\b",
    re.IGNORECASE,
)
EXPLICIT_OWNER_RE = re.compile(
    rf"(?:ответственн(?:ый|ая|ой|ого|ому)|исполнитель|жауапты|жауапкер)\s*[:—-]?\s*(?P<name>{PERSON_NAME}|юридический\s+департамент)(?=\s*(?:[,.;]|срок\b|дедлайн\b|мерзімі\b|$))",
    re.IGNORECASE,
)
DEPARTMENT_OWNER_RE = re.compile(r"\b(?P<name>юридический\s+департамент)\b", re.IGNORECASE)
# Names in the transcript are capitalized. Do not use IGNORECASE here: it
# would mistake a normal phrase such as "стратегию закупа сырья," for a name.
ADDRESSED_PERSON_RE = re.compile(rf"(?P<name>{PERSON_NAME}),\s*(?:вы\s+)?")
SELF_COMMITMENT_RE = re.compile(
    r"\b(сделаю|подготовлю|проведу|проверю|организую|дайындап|дайындаймын|"
    r"өткіземін|тексеремін|жасаймын|келісемін)\b",
    re.IGNORECASE,
)
ACK_RE = re.compile(
    r"^\s*(?:хорошо\s*,\s*)?(?:принято|понял(?:а)?|сделаю|подготовлю|проверю|"
    r"жақсы|түсіндім|орындаймын|дайындаймын)[.!…]?\s*$",
    re.IGNORECASE,
)
ORDINAL_LABELS = {"первое", "второе", "третье", "четвертое", "пятое"}
MONTH_RE = r"(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)"
UNKNOWN_SPEAKERS = {"speaker-unknown", "Не определён", "Спикер не определён", "Говорящий не определён"}


@dataclass
class Segment:
    speaker: str
    text: str
    start: float = 0.0
    end: float = 0.0


@dataclass
class ActionItem:
    id: str
    title: str
    responsible: str | None
    deadline: str | None
    evidence: dict[str, Any]
    requires_review: bool


def _read_segments(payload: dict[str, Any] | list[dict[str, Any]]) -> list[Segment]:
    raw_segments = payload if isinstance(payload, list) else payload.get("segments", payload.get("transcript", []))
    if not isinstance(raw_segments, list):
        raise ValueError("Ожидается массив segments или transcript.")
    segments: list[Segment] = []
    for item in raw_segments:
        text = str(item.get("text", "")).strip()
        if text:
            segments.append(
                Segment(
                    speaker=str(item.get("speaker", item.get("speaker_id")) or "Спикер не определён"),
                    text=text,
                    start=float(item.get("start", 0)),
                    end=float(item.get("end", 0)),
                )
            )
    return segments


def _sentences(text: str) -> list[str]:
    return [sentence.strip(" —–-:;,") for sentence in re.split(r"(?<=[.!?])\s+", text) if sentence.strip()]


def _merge_adjacent_segments(segments: list[Segment]) -> list[Segment]:
    """Rebuild sentences while preserving the bounds of their source segments."""
    if not segments:
        return []
    blocks = [[segments[0]]]
    for candidate in segments[1:]:
        previous = blocks[-1][-1]
        if candidate.speaker == previous.speaker and -1.5 <= candidate.start - previous.end <= 1.5:
            blocks[-1].append(candidate)
        else:
            blocks.append([candidate])
    rebuilt = []
    for block in blocks:
        spans, offset = [], 0
        for source in block:
            spans.append((offset, offset + len(source.text), source))
            offset += len(source.text) + 1
        text = ' '.join(source.text for source in block)
        # Replace only the dot so character offsets still identify source audio.
        text = re.sub(rf'(?<=\d)\.(?=\s+{MONTH_RE}\b)', ' ', text, flags=re.IGNORECASE)
        begin = 0
        boundaries = [(m.start(), m.end()) for m in re.finditer(r'(?<=[.!?])\s+', text)] + [(len(text), len(text))]
        for end, next_begin in boundaries:
            quote = text[begin:end].strip()
            sources = [source for a, b, source in spans if a < end and b > begin]
            if quote and sources:
                rebuilt.append(Segment(block[0].speaker, quote, min(s.start for s in sources), max(s.end for s in sources)))
            begin = next_begin
    return rebuilt


def _timecode(seconds: float) -> str:
    minutes, seconds = divmod(max(0, int(seconds)), 60)
    return f"{minutes:02d}:{seconds:02d}"


def _extract_owner(sentence: str, previous_address: str | None, speaker: str) -> tuple[str | None, str | None]:
    explicit = EXPLICIT_OWNER_RE.search(sentence)
    if explicit:
        return explicit.group("name"), None

    department = DEPARTMENT_OWNER_RE.search(sentence)
    if department:
        return department.group("name"), None

    addressed = ADDRESSED_PERSON_RE.search(sentence)
    addressed_name = addressed.group("name") if addressed else None
    if addressed_name and addressed_name.lower() in ORDINAL_LABELS:
        addressed_name = None
    if addressed_name:
        return addressed_name, addressed_name
    if SELF_COMMITMENT_RE.search(sentence):
        return (None if speaker in UNKNOWN_SPEAKERS else speaker), None
    # Do not carry an old addressee into a new task. Missing data must remain
    # missing and be marked for review instead of becoming a wrong assignee.
    return None, None


def _clean_title(sentence: str) -> str:
    text = re.sub(r"^(?:первое|второе|третье|четв[её]ртое|пятое)\s*[, :—-]?\s*", "", sentence, flags=re.IGNORECASE)
    text = EXPLICIT_OWNER_RE.sub("", text)
    text = DEPARTMENT_OWNER_RE.sub("", text)
    text = ADDRESSED_PERSON_RE.sub("", text, count=1)
    # Remove the complete labelled deadline before the generic date matcher.
    # This also protects us from leaving "15 октября" after removing "срок до".
    text = re.sub(
        r"\b(?:срок|дедлайн)\b\s*[:—-]?\s*(?:до|к|на)\s+\d{1,2}\s+[А-Яа-яЁёӘәІіҢңҒғҮүҰұҚқӨөҺһ-]+\b",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = DEADLINE_RE.sub("", text)
    text = re.sub(r"\b(?:срок|дедлайн|мерзімі)\b\s*[,.:;-]?", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r",?\s*\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\b",
        "",
        text,
        flags=re.IGNORECASE,
    )
    # Relative dates such as "до завтра" are matched as "завтра"; remove
    # the now-empty preposition and trailing punctuation as well.
    text = re.sub(r"\b(?:до|к|на|в течение)\s*(?=[,.;:]|$)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s{2,}", " ", text).strip(" ,—–-:;.")
    return text[:280]


def extract_action_items(payload: dict[str, Any] | list[dict[str, Any]]) -> list[ActionItem]:
    """Return only evidence-based action items.

    A missing person or date is represented by `None` and marks the item for
    manual review. The function never invents a deadline or a responsible.
    """
    tasks: list[ActionItem] = []
    seen: set[tuple[str, str | None, str | None]] = set()
    last_addressed: str | None = None

    for segment in _merge_adjacent_segments(_read_segments(payload)):
        for sentence in _sentences(segment.text):
            owner, last_addressed = _extract_owner(sentence, last_addressed, segment.speaker)
            if not ACTION_RE.search(sentence) or ACK_RE.fullmatch(sentence):
                continue
            # A negated instruction is not an assignment to perform the action.
            action = ACTION_RE.search(sentence)
            if re.search(r"\bне\s+(?:нужно\s+|надо\s+)?$", sentence[:action.start()], re.IGNORECASE):
                continue
            deadline_match = DEADLINE_RE.search(sentence)
            title = _clean_title(sentence)
            deadline = ' '.join(deadline_match.group(0).split()) if deadline_match else None
            fingerprint = (re.sub(r"[^\w]+", "", title.lower()), owner, deadline)
            if not title or fingerprint in seen:
                continue
            seen.add(fingerprint)
            tasks.append(
                ActionItem(
                    id=f"task-{len(tasks) + 1}",
                    title=title,
                    responsible=owner,
                    deadline=deadline,
                    evidence={
                        "speaker": segment.speaker,
                        "start": _timecode(segment.start),
                        "end": _timecode(segment.end),
                        "quote": sentence,
                    },
                    requires_review=owner is None or deadline is None or bool(re.search(r'предлагаю|может|\?', sentence, re.IGNORECASE)),
                )
            )
    return tasks


def build_summary(payload: dict[str, Any] | list[dict[str, Any]], tasks: list[ActionItem]) -> dict[str, Any]:
    """Evidence-based extractive summary; no generated facts or cloud calls."""
    from ai.summary import summarize
    segments = _read_segments(payload)
    result = summarize(_merge_adjacent_segments(segments), tasks)
    result['segment_count'] = len(segments)
    return result


def analyse(payload: dict[str, Any] | list[dict[str, Any]]) -> dict[str, Any]:
    segments = _read_segments(payload)
    normalized = [asdict(segment) for segment in segments]
    tasks = extract_action_items(normalized)
    return {
        "schema_version": 1,
        "summary": build_summary(normalized, tasks),
        "tasks": [asdict(task) for task in tasks],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальный анализ транскрипта совещания.")
    parser.add_argument("input", type=Path, help="JSON с полем segments или transcript")
    parser.add_argument("output", type=Path, help="Куда сохранить JSON с саммари и поручениями")
    args = parser.parse_args()
    # Accept UTF-8 with or without BOM: PowerShell-friendly tools in this
    # project write UTF-8-SIG, while backend JSON may be plain UTF-8.
    payload = json.loads(args.input.read_text(encoding="utf-8-sig"))
    result = analyse(payload)
    # BOM keeps Cyrillic readable in Windows PowerShell 5.1's default Get-Content.
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8-sig")


if __name__ == "__main__":
    main()
