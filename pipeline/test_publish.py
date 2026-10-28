"""Publisher checks with an in-memory R2 stand-in; no network or credentials."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from publish import Mirror
from publish_usage import Usage


class Store:
    def __init__(self):
        self.uploads = []

    def list_objects_v2(self, **kw):
        return {}

    def upload_file(self, path, bucket, key, **kw):
        self.uploads.append(key)

    def delete_objects(self, **kw):
        pass


class PublishTest(unittest.TestCase):
    def test_history_batches_but_recent_playback_stays_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ['days/2026-10-26.json', 'days.json', 'live.json', 'minute.mp3']:
                p = root / name
                p.parent.mkdir(exist_ok=True)
                p.write_text('first')
            store = Store()
            mirror = Mirror(store, 'bucket', root, 'live/')
            mirror.sync()
            self.assertLess(store.uploads.index('live/minute.mp3'), store.uploads.index('live/live.json'))
            self.assertLess(store.uploads.index('live/days/2026-10-26.json'), store.uploads.index('live/days.json'))
            store.uploads.clear()
            for p in root.rglob('*'):
                if p.is_file(): p.write_text('changed and longer')
            mirror.sync(history=False)
            self.assertEqual(store.uploads, ['live/minute.mp3', 'live/live.json'])
            store.uploads.clear()
            mirror.sync(history=True)
            self.assertEqual(store.uploads, ['live/days/2026-10-26.json', 'live/days.json'])

    def test_failed_media_does_not_publish_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'minute.mp3').write_bytes(b'audio')
            (root / 'live.json').write_text('{}')
            store = Store()
            with patch.object(store, 'upload_file', side_effect=RuntimeError('offline')):
                with self.assertRaises(RuntimeError):
                    Mirror(store, 'bucket', root, 'live/').sync()
            self.assertEqual(store.uploads, [])

    def test_usage_survives_restart_and_preserves_stream_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'usage.json'
            usage = Usage(path)
            stream = io.BytesIO(b'abcdef')
            stream.seek(2)
            usage.record(SimpleNamespace(name='PutObject'), {'body': stream})
            self.assertEqual(stream.tell(), 2)
            usage.record(SimpleNamespace(name='ListObjectsV2'), {})
            usage.save()
            restarted = Usage(path)
            restarted.record(SimpleNamespace(name='PutObject'), {'body': b'123'})
            restarted.save()
            row = next(iter(json.loads(path.read_text())['days'].values()))
            self.assertEqual(row['upload_bytes'], 7)
            self.assertEqual(row['operations'], {'PutObject': 2, 'ListObjectsV2': 1})


if __name__ == '__main__':
    unittest.main()


class PauseStore:
    """Holds control/pause.json, or nothing."""
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self, body=None):
        self.body = body

    def get_object(self, Bucket, Key):
        if self.body is None:
            raise self.exceptions.NoSuchKey()
        return {"Body": io.BytesIO(self.body.encode())}


class FetchPauseTest(unittest.TestCase):
    def test_copies_the_pause_and_keeps_it_on_bad_json(self):
        from publish import fetch_pause
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            fetch_pause(PauseStore(), "b", data)
            self.assertEqual(json.loads((data / "pause.json").read_text()), {"set_at": None, "until": None})
            fetch_pause(PauseStore(json.dumps({"until": "2026-10-28T23:30:00.000Z", "set_at": "2026-10-28T22:30:00.000Z"})), "b", data)
            self.assertEqual(json.loads((data / "pause.json").read_text()), {"set_at": "2026-10-28T22:30:00.000Z", "until": "2026-10-28T23:30:00.000Z"})
            fetch_pause(PauseStore("not json"), "b", data)
            self.assertEqual(json.loads((data / "pause.json").read_text()), {"set_at": "2026-10-28T22:30:00.000Z", "until": "2026-10-28T23:30:00.000Z"})
            self.assertFalse((data / "pause.json.part").exists())
