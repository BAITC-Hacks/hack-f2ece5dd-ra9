# Модуль AI-анализа текста

Это часть Жана. Она не распознаёт аудио и не меняет интерфейс: получает готовый транскрипт от backend и возвращает саммари с поручениями.

## Входной контракт

```json
{
  "segments": [
    {"speaker": "Асхат Ерланович", "start": 31.0, "end": 39.0, "text": "Подготовить отчёт до 15 октября, ответственный Гульмира Сериковна."}
  ]
}
```

## Выходной контракт

```json
{
  "schema_version": 1,
  "summary": {"text": "...", "key_points": ["..."]},
  "tasks": [
    {
      "id": "task-1",
      "title": "Подготовить отчёт",
      "responsible": "Гульмира Сериковна",
      "deadline": "до 15 октября",
      "evidence": {"speaker": "Асхат Ерланович", "start": "00:31", "end": "00:39", "quote": "..."},
      "requires_review": false
    }
  ]
}
```

`responsible` и `deadline` остаются `null`, если их нет в исходной реплике. Это принципиально: модуль не должен выдумывать людей или сроки.

## Проверка без зависимостей

```powershell
python -m unittest discover -s tests
python -m ai.analyzer tests/fixtures/transcript.json result.json
```

Backend подключает анализ так:

```python
from ai.analyzer import analyse

result = analyse({"segments": transcript_segments})
```
