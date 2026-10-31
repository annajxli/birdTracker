"""Publisher checks with an in-memory R2 stand-in; no network or credentials."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import db
import publish
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


class ClientErrorStore:
    """Just enough of R2: objects by key, as bytes."""

    def __init__(self, objects=None):
        self.objects, self.deleted = dict(objects or {}), []

    def head_object(self, Bucket, Key):
        from botocore.exceptions import ClientError
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def list_objects_v2(self, Bucket, Prefix, **kw):
        return {"Contents": [{"Key": k, "Size": len(v)} for k, v in self.objects.items() if k.startswith(Prefix)]}

    def upload_file(self, path, bucket, key, **kw):
        self.objects[key] = Path(path).read_bytes()

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects[Key] = Body

    def download_file(self, bucket, key, path):
        Path(path).write_bytes(self.objects[key])

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key)

    def delete_objects(self, Bucket, Delete):
        for o in Delete["Objects"]:
            self.deleted.append(o["Key"])
            self.objects.pop(o["Key"])


class LostDataTest(unittest.TestCase):
    """A new card's empty database and folders must not replace what the bucket holds."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def database(self, name, rows=0):
        path = self.tmp / name
        conn = db.connect(path)
        conn.executemany("INSERT INTO detections (station_id, detected_at, scientific_name, common_name, confidence) VALUES ('b', ?, 'A b', 'C', 0.9)",
                         [(f"2026-10-{i:06d}",) for i in range(rows)])
        conn.commit()
        conn.close()
        return path

    def test_an_empty_database_does_not_replace_the_snapshot(self):
        big = self.database("big.sqlite", 5000).read_bytes()
        store = ClientErrorStore({publish.SNAPSHOT_KEY: big})
        with self.assertLogs("publish", "ERROR"):
            self.assertFalse(publish.snapshot(store, "b", self.database("new.sqlite")))
        self.assertEqual(store.objects[publish.SNAPSHOT_KEY], big)
        self.assertEqual(list(store.objects), [publish.SNAPSHOT_KEY])

    def test_allow_shrink_replaces_it(self):
        store = ClientErrorStore({publish.SNAPSHOT_KEY: self.database("big.sqlite", 5000).read_bytes()})
        self.assertTrue(publish.snapshot(store, "b", self.database("new.sqlite"), allow_shrink=True))

    def test_a_first_snapshot_uploads_and_old_days_are_dropped(self):
        old = {f"{publish.SNAPSHOTS_PREFIX}2026-01-{d:02d}.sqlite": b"x" for d in range(1, 21)}
        store = ClientErrorStore(old)
        self.assertTrue(publish.snapshot(store, "b", self.database("new.sqlite", 3)))
        self.assertIn(publish.SNAPSHOT_KEY, store.objects)
        days = [k for k in store.objects if k.startswith(publish.SNAPSHOTS_PREFIX)]
        self.assertEqual(len(days), publish.SNAPSHOT_KEEP_DAYS)
        self.assertNotIn(f"{publish.SNAPSHOTS_PREFIX}2026-01-01.sqlite", days)

    def test_a_folder_with_only_new_files_does_not_empty_the_prefix(self):
        live = self.tmp / "live"
        live.mkdir()
        (live / "status.json").write_text("{}")
        remote = {f"live/{i}.webp": b"x" for i in range(100)}
        store = ClientErrorStore(remote)
        with self.assertLogs("publish", "ERROR"):
            Mirror(store, "b", live, "live/").sync()
        self.assertEqual(store.deleted, [])
        Mirror(store, "b", live, "live/", allow_mass_delete=True).sync()
        self.assertEqual(len(store.deleted), 100)

    def test_ordinary_pruning_still_deletes(self):
        live = self.tmp / "live"
        live.mkdir()
        for i in range(100):
            (live / f"{i}.webp").write_bytes(b"x")
        store = ClientErrorStore({**{f"live/{i}.webp": b"x" for i in range(100)}, "live/old.webp": b"x"})
        Mirror(store, "b", live, "live/").sync()
        self.assertEqual(store.deleted, ["live/old.webp"])

    def test_restore_fetches_what_is_missing(self):
        snap = self.database("snap.sqlite", 3).read_bytes()
        store = ClientErrorStore({"clips/2026/a.flac": b"clip", "live/live.json": b"{}", publish.SNAPSHOT_KEY: snap})
        data, target = self.tmp / "data", self.tmp / "data" / "recorder.sqlite"
        data.mkdir()
        db.connect(target).close()  # the analyzer has already made an empty one
        publish.restore(store, "b", data, target)
        self.assertEqual((data / "clips/2026/a.flac").read_bytes(), b"clip")
        self.assertEqual((data / "live/live.json").read_bytes(), b"{}")
        self.assertEqual(target.read_bytes(), snap)

    def test_restore_keeps_a_database_with_detections(self):
        target = self.database("kept.sqlite", 1)
        before = target.read_bytes()
        publish.restore(ClientErrorStore({publish.SNAPSHOT_KEY: b"other"}), "b", self.tmp, target)
        self.assertEqual(target.read_bytes(), before)


class ReviewStore(ClientErrorStore):
    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}


class ApplyReviewsTest(unittest.TestCase):
    def test_a_malformed_review_is_dropped_and_the_rest_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "d.sqlite"
            conn = db.connect(path)
            conn.execute("INSERT INTO detections (station_id, detected_at, scientific_name, common_name, confidence) VALUES ('b', '2026-10-01T00:00:00Z', 'A b', 'C', 0.9)")
            conn.commit()
            good = {"at": "2026-10-02T00:00:00.000Z", "verdict": "rejected", "detections": [{"at": "2026-10-01T00:00:00Z", "scientific": "A b"}]}
            bad = {**good, "verdict": "confirmed", "detections": [good["detections"][0], {"at": ["2026-10-01T00:00:00Z"], "scientific": "A b"}]}
            store = ReviewStore({"reviews/1.json": json.dumps(good).encode(), "reviews/2.json": json.dumps(bad).encode()})
            with self.assertLogs("publish", "WARNING"):
                self.assertEqual(publish.apply_reviews(store, "b", path, Path(tmp) / "live"), 2)
            self.assertEqual(store.objects, {})
            self.assertEqual(conn.execute("SELECT review FROM detections").fetchone()[0], "rejected")  # none of the bad one
            conn.close()
