import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import wave

from fastapi.testclient import TestClient
from backend.app import create_app
from backend.recorder import AudioFiles, Recorder, save_json
from backend.teams import validate_meeting_url


class FileTests(unittest.TestCase):
    def test_chunks_reassemble_exactly_without_missing_or_duplicate_frames(self):
        with TemporaryDirectory() as root:
            directory = Path(root)
            files = AudioFiles(directory, rate=16000, channels=2)
            pcm = b'\x01\x02\x03\x04' * (16000 * 12 + 17)
            for offset in range(0, len(pcm), 4096):
                files.write(pcm[offset:offset + 4096])
            # Only completed chunks are published during recording.
            self.assertEqual(len(files.chunks), 2)
            files.close()
            self.assertEqual(len(files.chunks), 3)
            self.assertAlmostEqual(files.chunks[2]['duration'], 2 + 17 / 16000)
            rebuilt = b''
            for chunk in files.chunks:
                with wave.open(str(directory / chunk['file'])) as audio:
                    self.assertEqual(audio.getframerate(), 16000)
                    self.assertEqual(audio.getnchannels(), 2)
                    rebuilt += audio.readframes(audio.getnframes())
            self.assertEqual(rebuilt, pcm)
            with wave.open(str(directory / 'recording.wav')) as audio:
                self.assertEqual(audio.readframes(audio.getnframes()), pcm)
            self.assertFalse(list(directory.glob('*.part')))

    def test_empty_recording_is_valid_wav(self):
        with TemporaryDirectory() as root:
            files = AudioFiles(Path(root), rate=48000, channels=2)
            files.close()
            with wave.open(str(Path(root) / 'recording.wav')) as audio:
                self.assertEqual(audio.getnframes(), 0)

    def test_restart_marks_unfinished_session_interrupted(self):
        with TemporaryDirectory() as root:
            directory = Path(root) / ('a' * 32)
            directory.mkdir()
            save_json(directory / 'session.json', {'status': 'recording'})
            Recorder(Path(root))
            self.assertEqual(json.loads((directory / 'session.json').read_text())['status'], 'interrupted')


class TeamsTests(unittest.TestCase):
    def test_accepts_meeting_links(self):
        for url in ['https://teams.microsoft.com/meet/123?p=example',
                    'https://teams.microsoft.com/l/meetup-join/example',
                    'https://teams.live.com/meet/123']:
            self.assertEqual(validate_meeting_url(url), url)

    def test_rejects_non_meetings_and_host_spoofing(self):
        for url in ['file:///C:/Windows/notepad.exe', 'http://teams.microsoft.com/meet/1',
                    'https://teams.microsoft.com.evil.test/meet/1',
                    'https://teams.microsoft.com@evil.test/meet/1',
                    'https://teams.microsoft.com/meet/1\n--flag',
                    'https://teams.microsoft.com:broken/meet/1',
                    'https://teams.microsoft.com/']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_meeting_url(url)


class FakeRecorder:
    def __init__(self): self.current = None
    def snapshot(self): return self.current
    def start(self, **kwargs):
        if self.current: raise ValueError('Запись уже запущена.')
        self.current = {'id': 'a' * 32, 'status': 'recording'}
        return self.current
    def stop(self):
        if self.current: self.current['status'] = 'completed'
        return self.current


class FakeTranscription:
    def ensure_idle(self): pass
    def start(self, session_id): pass
    def notify(self): pass
    def read(self, session_id, after=0):
        return {'session_id': session_id, 'segments': [], 'next_cursor': 0, 'status': 'waiting'}


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.recorder = FakeRecorder()
        self.client = TestClient(create_app(self.root, self.recorder, FakeTranscription()))
        self.token = self.client.get('/api/status').json()['csrf_token']
        self.headers = {'x-recorder-token': self.token}

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_recording_requires_token_and_acknowledgement(self):
        data = {'device_id': 10, 'acknowledged': True}
        self.assertEqual(self.client.post('/api/recordings/start', json=data).status_code, 403)
        self.assertEqual(self.client.post('/api/recordings/start', headers=self.headers, json={'device_id':10}).status_code, 400)
        self.assertEqual(self.client.post('/api/recordings/start', headers=self.headers, json=data).status_code, 201)
        self.assertEqual(self.client.post('/api/recordings/start', headers=self.headers, json=data).status_code, 409)
        self.assertEqual(self.client.post('/api/recordings/stop', headers=self.headers, json={}).json()['recording']['status'], 'completed')

    def test_rejects_cross_origin_write_and_wrong_host(self):
        self.assertEqual(self.client.post('/api/recordings/stop', headers={**self.headers,'origin':'https://elsewhere.test'},json={}).status_code,403)
        self.assertEqual(self.client.get('/api/status',headers={'host':'attacker.test'}).status_code,400)

    def test_only_completed_chunks_download_during_recording(self):
        directory = self.root / ('a' * 32)
        directory.mkdir()
        (directory / 'recording.wav').write_bytes(b'RIFF')
        (directory / 'chunk-00000.wav').write_bytes(b'RIFF')
        self.recorder.start()
        base = '/api/sessions/' + 'a' * 32 + '/files/'
        self.assertEqual(self.client.get(base + 'recording.wav').status_code,409)
        self.assertEqual(self.client.get(base + 'chunk-00000.wav').status_code,200)
        self.assertEqual(self.client.get(base + 'session.json').status_code,404)
        self.assertEqual(self.client.get('/api/sessions/invalid').status_code,404)
        self.assertEqual(self.client.get('/.env').status_code,404)

    def test_teams_launcher_returns_opened_not_joined(self):
        with patch('backend.app.open_guest_window', return_value={'status':'browser_opened','joined':False}):
            response = self.client.post('/api/teams/open', headers=self.headers, json={'url':'https://teams.microsoft.com/meet/123'})
        self.assertEqual(response.status_code,200)
        self.assertFalse(response.json()['joined'])


if __name__ == '__main__':
    unittest.main()
