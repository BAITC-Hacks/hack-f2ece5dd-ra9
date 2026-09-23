from __future__ import annotations

import unittest
from unittest.mock import patch

from ai.pipeline import process_recording


class PipelineTests(unittest.TestCase):
    @patch("ai.pipeline.transcribe_chunk")
    def test_builds_meeting_result_from_transcript(self, transcribe_chunk) -> None:
        transcribe_chunk.return_value = [
            {
                "speaker": "Спикер 1",
                "start": 5.0,
                "end": 9.0,
                "text": "Алия, подготовь отчёт до 15 октября.",
            }
        ]

        result = process_recording("recording.mp3")

        self.assertEqual(result["transcript"]["segments"], transcribe_chunk.return_value)
        self.assertEqual(result["tasks"][0]["responsible"], "Алия")
        self.assertEqual(result["tasks"][0]["deadline"], "до 15 октября")


if __name__ == "__main__":
    unittest.main()
