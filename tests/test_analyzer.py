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

    def test_merges_split_assignment_before_extracting_fields(self) -> None:
        result = analyse(
            {
                "segments": [
                    {"speaker": "Спикер 1", "start": 10, "end": 12, "text": "Первое, разработать"},
                    {
                        "speaker": "Спикер 1",
                        "start": 12,
                        "end": 17,
                        "text": "стратегию закупа сырья, ответственной Гульмира Сериковна, срок до 15 октября.",
                    },
                ]
            }
        )
        self.assertEqual(len(result["tasks"]), 1)
        task = result["tasks"][0]
        self.assertEqual(task["title"], "разработать стратегию закупа сырья")
        self.assertEqual(task["responsible"], "Гульмира Сериковна")
        self.assertEqual(task["deadline"], "до 15 октября")
        self.assertEqual(task["evidence"]["start"], "00:10")
        self.assertEqual(task["evidence"]["end"], "00:17")

    def test_does_not_copy_old_addressee_to_next_task(self) -> None:
        result = analyse(
            {
                "segments": [
                    {"speaker": "Спикер 1", "start": 0, "end": 2, "text": "Гульмира, проверь отчёт."},
                    {"speaker": "Спикер 1", "start": 10, "end": 12, "text": "Подготовить инструкцию."},
                ]
            }
        )
        self.assertEqual(result["tasks"][1]["responsible"], None)
        self.assertTrue(result["tasks"][1]["requires_review"])

    def test_stops_owner_name_before_deadline_label(self) -> None:
        result = analyse(
            {
                "segments": [
                    {
                        "speaker": "Спикер 1",
                        "text": "Подготовить финансовое решение, ответственный Тимур Баллатович срок до 30 сентября.",
                    }
                ]
            }
        )
        self.assertEqual(result["tasks"][0]["responsible"], "Тимур Баллатович")

    def test_detects_department_without_explicit_owner_word(self) -> None:
        result = analyse(
            {
                "segments": [
                    {
                        "speaker": "Спикер 1",
                        "text": "Провести юридическую проверку, юридический департамент, срок до 30 сентября.",
                    }
                ]
            }
        )
        task = result["tasks"][0]
        self.assertEqual(task["responsible"], "юридический департамент")
        self.assertEqual(task["title"], "Провести юридическую проверку")


if __name__ == "__main__":
    unittest.main()
