import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.recorder import AudioFiles, Recorder, save_json
from backend.transcription import TranscriptManager


SESSION_ID = 'b' * 32


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.02)
    raise AssertionError('Транскрипция не завершилась за отведённое время.')


class FakeRecognizer:
    def __init__(self, session_id):
        self.session_id = session_id
        self.calls = []
        self.closed = False

    def transcribe_chunk(self, wav_path, *, start_seconds):
        self.calls.append((wav_path.name, start_seconds))
        return [{'speaker_id': 'speaker-1' if start_seconds < 5 else 'speaker-2',
                 'start': start_seconds + .1, 'end': start_seconds + .5,
                 'text': f'Реплика {len(self.calls)}'}]

    def close(self):
        self.closed = True


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directory = self.root / SESSION_ID
        self.directory.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write_metadata(self, files, status):
        save_json(self.directory / 'session.json', {
            'id': SESSION_ID, 'status': status, 'chunks': list(files.chunks),
        })

    def test_completed_chunks_are_transcribed_in_order_while_recording(self):
        files = AudioFiles(self.directory, rate=100, channels=1)
        files.write(b'\x00\x01' * 1000)
        self.write_metadata(files, 'recording')
        recognizer = FakeRecognizer(SESSION_ID)
        manager = TranscriptManager(self.root, lambda session_id: recognizer)
        manager.start(SESSION_ID)
        wait_for(lambda: manager.read(SESSION_ID)['processed_chunks'] == 2)
        self.assertEqual(manager.read(SESSION_ID)['status'], 'waiting')
        self.assertEqual(recognizer.calls, [('chunk-00000.wav', 0.0), ('chunk-00001.wav', 5.0)])

        files.write(b'\x00\x01' * 100)
        files.close()
        self.write_metadata(files, 'completed')
        manager.notify()
        wait_for(lambda: manager.read(SESSION_ID)['status'] == 'completed')
        result = manager.read(SESSION_ID, after=1)
        self.assertEqual(result['next_cursor'], 3)
        self.assertEqual(len(result['segments']), 2)
        self.assertEqual([segment['speaker_id'] for segment in result['segments']],
                         ['speaker-2', 'speaker-2'])
        self.assertEqual(result['segments'][0]['start'], 5.1)
        self.assertTrue(all(segment['is_final'] for segment in result['segments']))
        self.assertTrue(recognizer.closed)
        self.assertIn('Реплика 3', (self.directory / 'transcript.txt').read_text(encoding='utf-8'))

    def test_local_timestamps_from_later_chunk_are_rejected(self):
        files = AudioFiles(self.directory, rate=100, channels=1)
        files.write(b'\x00\x01' * 1000)
        files.close()
        self.write_metadata(files, 'completed')

        class WrongTimestamp:
            def transcribe_chunk(self, wav_path, *, start_seconds):
                return [{'speaker_id': 'speaker-1', 'start': .1, 'end': .5, 'text': 'Текст'}]

        manager = TranscriptManager(self.root, lambda session_id: WrongTimestamp())
        manager.start(SESSION_ID)
        wait_for(lambda: manager.read(SESSION_ID)['status'] == 'error')
        self.assertEqual(manager.read(SESSION_ID)['processed_chunks'], 1)
        self.assertIn('начала встречи', manager.read(SESSION_ID)['error'])
        self.assertTrue((self.directory / 'recording.wav').exists())

    def test_missing_model_is_reported_without_fake_transcript(self):
        save_json(self.directory / 'session.json', {'id': SESSION_ID, 'status': 'recording', 'chunks': []})
        manager = TranscriptManager(self.root)
        with patch('backend.transcription.recognizer_available', return_value=False):
            manager.start(SESSION_ID)
            wait_for(lambda: manager.read(SESSION_ID)['status'] == 'unavailable')
        self.assertEqual(manager.read(SESSION_ID)['segments'], [])

    def test_api_returns_only_new_segments_and_txt_download(self):
        save_json(self.directory / 'session.json', {'id': SESSION_ID, 'status': 'completed', 'chunks': []})
        manager = TranscriptManager(self.root)
        state = {
            'schema_version': 1, 'session_id': SESSION_ID, 'status': 'completed',
            'revision': 1, 'processed_chunks': 1,
            'segments': [{'id': 'seg-00000-000', 'speaker_id': 'speaker-1',
                          'start': 1.2, 'end': 2.4, 'text': 'Добрый день', 'is_final': True}],
            'error': None, 'updated_at': '2026-09-23T00:00:00Z',
        }
        save_json(self.directory / 'transcript.json', state)
        (self.directory / 'transcript.txt').write_text('[1.20–2.40] speaker-1: Добрый день\n', encoding='utf-8')
        with TestClient(create_app(self.root, Recorder(self.root), manager)) as client:
            base = f'/api/sessions/{SESSION_ID}'
            result = client.get(base + '/transcript?after=0').json()
            self.assertEqual(result['segments'][0]['text'], 'Добрый день')
            self.assertEqual(client.get(base + '/transcript?after=1').json()['segments'], [])
            self.assertEqual(client.get(base + '/transcript.txt').status_code, 200)
            self.assertEqual(client.get(base + '/transcript?after=-1').status_code, 422)
            self.assertEqual(client.get('/api/sessions/invalid/transcript').status_code, 404)


if __name__ == '__main__':
    unittest.main()
