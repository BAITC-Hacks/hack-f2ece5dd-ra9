from __future__ import annotations

import json
import unittest
from pathlib import Path

from ai.analyzer import analyse


class AnalyzerTests(unittest.TestCase):
    def setUp(self) -> None:
        fixture = Path(__file__).parent / "fixtures" / "transcript.json"
        self.payload = json.loads(fixture.read_text(encoding="utf-8"))

    def test_extracts_explicit_responsible_and_deadline(self) -> None:
        result = analyse(self.payload)
        first_task = result["tasks"][0]
        self.assertEqual(first_task["title"], "разработать стратегию закупа сырья")
        self.assertEqual(first_task["responsible"], "Гульмира Сериковна")
        self.assertEqual(first_task["deadline"], "до 15 октября")
        self.assertFalse(first_task["requires_review"])

    def test_recognizes_imperative_action(self) -> None:
        result = analyse(self.payload)
        self.assertEqual(len(result["tasks"]), 2)
        self.assertEqual(result["tasks"][1]["title"], "проверь звук в Teams и Zoom")
        self.assertEqual(result["tasks"][1]["deadline"], "до завтра")

    def test_does_not_invent_missing_fields(self) -> None:
        result = analyse({"segments": [{"speaker": "Спикер 1", "text": "Подготовить инструкцию запуска."}]})
        task = result["tasks"][0]
        self.assertIsNone(task["responsible"])
        self.assertIsNone(task["deadline"])
        self.assertTrue(task["requires_review"])

    def test_supports_kazakh_action_and_relative_deadline(self) -> None:
        result = analyse(
            {
                "segments": [
                    {
                        "speaker": "Асхат Ерланович",
                        "start": 60,
                        "end": 70,
                        "text": "Гульмира, есепті дайындаңыз, мерзімі ертеңге дейін, жауапты Гульмира Сериковна.",
                    }
                ]
            }
        )
        task = result["tasks"][0]
        self.assertIn("есепті дайындаңыз", task["title"])
        self.assertEqual(task["responsible"], "Гульмира Сериковна")
        self.assertEqual(task["deadline"], "ертеңге дейін")

    def test_summary_ignores_short_acknowledgements(self) -> None:
        result = analyse(
            {
                "segments": [
                    {"speaker": "Спикер 1", "text": "Обсудили бюджет проекта."},
                    {"speaker": "Спикер 2", "text": "Хорошо, проверю."},
                ]
            }
        )
        self.assertEqual(result["summary"]["key_points"], ["Обсудили бюджет проекта."])

    def test_supports_mixed_russian_kazakh_action(self) -> None:
        result = analyse(
            {
                "segments": [
                    {
                        "speaker": "Асхат Ерланович",
                        "text": "Алия, подготовь есепті до завтра, жауапты Алия.",
                    }
                ]
            }
        )
        task = result["tasks"][0]
        self.assertIn("подготовь есепті", task["title"])
        self.assertEqual(task["responsible"], "Алия")
        self.assertEqual(task["deadline"], "до завтра")


if __name__ == "__main__":
    unittest.main()
