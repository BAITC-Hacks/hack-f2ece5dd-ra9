from __future__ import annotations

import unittest

from ai.transcriber import normalize_segments


class Segment:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start = start
        self.end = end
        self.text = text


class TranscriberTests(unittest.TestCase):
    def test_normalizes_whisper_segments_to_project_contract(self) -> None:
        result = normalize_segments([Segment(1.234, 4.567, "  Проверить звук.  ")])
        self.assertEqual(
            result,
            [
                {
                    "speaker": "speaker-unknown",
                    "start": 1.23,
                    "end": 4.57,
                    "text": "Проверить звук.",
                }
            ],
        )

    def test_skips_empty_segments(self) -> None:
        self.assertEqual(normalize_segments([Segment(0, 1, "   ")]), [])


if __name__ == "__main__":
    unittest.main()
