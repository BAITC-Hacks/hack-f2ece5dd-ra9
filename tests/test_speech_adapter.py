from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest
import wave

from speech.recognizer import create_recognizer


class SpeechAdapterTests(unittest.TestCase):
    def test_converts_offsets_clips_padding_and_does_not_invent_speakers(self):
        with TemporaryDirectory() as root:
            path = Path(root) / 'chunk.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(b'\0\0' * 16000 * 5)
            with patch('speech.recognizer.transcribe_chunk', return_value=[
                {'speaker': 'Спикер 1', 'start': .2, 'end': 6.0, 'text': 'Проверка'},
                {'speaker': 'Спикер 1', 'start': 6, 'end': 7, 'text': 'За пределами'},
            ]):
                result = create_recognizer('test').transcribe_chunk(path, start_seconds=10)
            self.assertEqual(result, [{'speaker_id': 'speaker-unknown', 'start': 10.2,
                                       'end': 15.0, 'text': 'Проверка'}])


if __name__ == '__main__':
    unittest.main()
