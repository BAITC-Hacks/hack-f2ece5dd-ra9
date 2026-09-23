# Модуль AI-анализа текста

Это часть Жана. Она состоит из двух независимых модулей:

- `transcriber.py` локально распознаёт аудио и возвращает сегменты транскрипта;
- `analyzer.py` получает эти сегменты и возвращает саммари с поручениями.

`transcriber.py` не захватывает системный звук и не определяет личность по голосу. Backend сохраняет короткие аудиочанки и вызывает его, а модуль диаризации позднее заменяет метку `Спикер 1` на `Спикер 1/2/...`.

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

## Локальная транскрипция

Установка модели и рантайма выполняется один раз на ноутбуке Жалгаса:

```powershell
py -m pip install -r ai/requirements.txt
```

Для первого прогона используем `base` и CPU: это самый надёжный режим на Windows. Модель автоматически скачается при первом запуске.

```powershell
py -m ai.transcriber "C:\путь\к\совещанию.mp3" transcript.json
```

Если CUDA уже проверена на ноутбуке, можно ускорить распознавание:

```powershell
py -m ai.transcriber "C:\путь\к\совещанию.mp3" transcript.json --device cuda
```

Результат имеет контракт:

```json
{"segments": [{"speaker": "Спикер 1", "start": 0.0, "end": 4.2, "text": "..."}]}
```

Для почти реального времени backend записывает фрагменты по 10–15 секунд и для каждого вызывает:

```python
from ai.transcriber import transcribe_chunk

segments = transcribe_chunk("work/chunk-001.wav")
```

## Итог после завершения звонка

Единый модуль связывает распознавание и анализ. Он не обучает модель: готовый
`faster-whisper` превращает звук в текст, а `analyzer.py` выделяет поручения
только по словам из этого текста.

```powershell
py -m ai.pipeline "C:\путь\к\совещанию.mp3" meeting-result.json
```

`meeting-result.json` содержит три поля для backend и UI:

```json
{
  "transcript": {"segments": []},
  "summary": {"text": "...", "key_points": []},
  "tasks": []
}
```

Подключение в Python backend:

```python
from ai.pipeline import process_recording

meeting = process_recording("recordings/meeting.mp3")
```

`faster-whisper` распознаёт речь и выдаёт таймкоды, но сам не различает
личности людей по голосу. Для MVP задача получает ответственного из фразы
вроде «Алия, подготовь отчёт до 15 октября»; если имя или срок не названы,
поле остаётся `null` и задача отмечается для проверки.

## Проверка анализатора без ML-зависимостей

```powershell
python -m unittest discover -s tests
python -m ai.analyzer tests/fixtures/transcript.json result.json
```

Backend подключает анализ так:

```python
from ai.analyzer import analyse

result = analyse({"segments": transcript_segments})
```
