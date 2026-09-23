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
    r"ұсын\w*|бекіт\w*|орында\w*|жібер\w*)\b",
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
    rf"(?:ответственн(?:ый|ая)|исполнитель|жауапты|жауапкер)\s*[:—-]?\s*(?P<name>{PERSON_NAME}|юридический\s+департамент)",
    re.IGNORECASE,
)
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
                    speaker=str(item.get("speaker", "Спикер не определён")),
                    text=text,
                    start=float(item.get("start", 0)),
                    end=float(item.get("end", 0)),
                )
            )
    return segments


def _sentences(text: str) -> list[str]:
    return [sentence.strip(" —–-:;,") for sentence in re.split(r"(?<=[.!?])\s+", text) if sentence.strip()]


def _timecode(seconds: float) -> str:
    minutes, seconds = divmod(max(0, int(seconds)), 60)
    return f"{minutes:02d}:{seconds:02d}"


def _extract_owner(sentence: str, previous_address: str | None, speaker: str) -> tuple[str | None, str | None]:
    explicit = EXPLICIT_OWNER_RE.search(sentence)
    if explicit:
        return explicit.group("name"), previous_address

    addressed = ADDRESSED_PERSON_RE.search(sentence)
    addressed_name = addressed.group("name") if addressed else previous_address
    if SELF_COMMITMENT_RE.search(sentence):
        return speaker, addressed_name
    return addressed_name, addressed_name


def _clean_title(sentence: str) -> str:
    text = re.sub(r"^(?:первое|второе|третье|четв[её]ртое|пятое)\s*[:—-]?\s*", "", sentence, flags=re.IGNORECASE)
    text = ADDRESSED_PERSON_RE.sub("", text, count=1)
    text = EXPLICIT_OWNER_RE.sub("", text)
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
    seen: set[str] = set()
    last_addressed: str | None = None

    for segment in _read_segments(payload):
        for sentence in _sentences(segment.text):
            owner, last_addressed = _extract_owner(sentence, last_addressed, segment.speaker)
            if not ACTION_RE.search(sentence):
                continue
            deadline_match = DEADLINE_RE.search(sentence)
            title = _clean_title(sentence)
            fingerprint = re.sub(r"[^\w]+", "", title.lower())
            if not title or fingerprint in seen:
                continue
            seen.add(fingerprint)
            deadline = deadline_match.group(0) if deadline_match else None
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
                    requires_review=owner is None or deadline is None,
                )
            )
    return tasks


def build_summary(payload: dict[str, Any] | list[dict[str, Any]], tasks: list[ActionItem]) -> dict[str, Any]:
    segments = _read_segments(payload)
    discussion = [
        segment.text
        for segment in segments
        if not ACTION_RE.search(segment.text) and not ACK_RE.match(segment.text)
    ]
    key_points = discussion[:3]
    if not key_points:
        key_points = [task.title for task in tasks[:3]]
    text = f"Распознано реплик: {len(segments)}. Выделено поручений: {len(tasks)}."
    if any(task.requires_review for task in tasks):
        text += " Часть поручений требует проверки: не указан срок или ответственный."
    return {"text": text, "key_points": key_points}


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
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    result = analyse(payload)
    # BOM keeps Cyrillic readable in Windows PowerShell 5.1's default Get-Content.
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8-sig")


if __name__ == "__main__":
    main()
