"""Receiver checks: minute files around a recorder pause, frame counts, and the firmware and time endpoints on localhost."""
import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
import wave
from datetime import UTC, datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import receiver
from receiver import Handler, MinuteFiles, Pause, remove_stale_parts

RATE = 100  # samples per second, small so a minute is cheap
T0 = 1_800_000_000 - 1_800_000_000 % 60  # a whole UTC minute


def iso(t):
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class PauseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.path = self.dir / "pause.json"

    def tearDown(self):
        self.tmp.cleanup()

    def set_pause(self, until, set_at=T0 - 600):
        self.path.write_text(json.dumps({"set_at": iso(set_at), "until": until and iso(until)}))
        os.utime(self.path, ns=(time.time_ns(), time.time_ns() + 1000))  # a new mtime even within a tick

    def stream(self, files, seconds, start=0):
        for s in range(start, start + seconds):  # one-second frames
            files.add(s * RATE, b"\1\0" * RATE)
        files.close()

    def wavs(self):
        out = {}
        for p in sorted(self.dir.glob("*.wav")):
            with wave.open(str(p)) as w:
                out[p.name] = w.getnframes() / RATE
        return out

    def test_no_pause_file_records(self):
        files = MinuteFiles(self.dir, RATE, 0, T0 * 1000, "test", None, pause=Pause(self.path))
        self.stream(files, 60)
        self.assertEqual(list(self.wavs().values()), [60])

    def test_audio_inside_a_pause_is_dropped(self):
        self.set_pause(T0 + 20)
        files = MinuteFiles(self.dir, RATE, 0, T0 * 1000, "test", None, pause=Pause(self.path))
        self.stream(files, 60)
        name = datetime.fromtimestamp(T0 + 20, UTC).strftime("%Y%m%dT%H%M%SZ.wav")
        self.assertEqual(self.wavs(), {name: 40})

    def test_a_pause_closes_the_open_minute(self):
        pause = Pause(self.path)
        files = MinuteFiles(self.dir, RATE, 0, T0 * 1000, "test", None, pause=pause)
        for s in range(30):
            files.add(s * RATE, b"\1\0" * RATE)
        self.set_pause(T0 + 50)
        self.stream(files, 30, start=30)
        first = datetime.fromtimestamp(T0, UTC).strftime("%Y%m%dT%H%M%SZ.wav")
        second = datetime.fromtimestamp(T0 + 50, UTC).strftime("%Y%m%dT%H%M%SZ.wav")
        self.assertEqual(self.wavs(), {first: 30, second: 10})
        self.assertFalse(list(self.dir.glob("*.part")))

    def test_audio_from_before_the_pause_was_set_is_kept(self):
        pause = Pause(self.path)
        self.set_pause(T0 + 3600, set_at=T0 + 600)
        self.assertFalse(pause.active(T0, T0 + 60))  # a late upload recorded before the pause
        self.assertTrue(pause.active(T0 + 590, T0 + 650))  # a minute running into it
        self.assertTrue(pause.active(T0 + 1200))
        self.assertFalse(pause.active(T0 + 3600))

    def test_an_ended_or_cleared_pause_records(self):
        pause = Pause(self.path)
        self.set_pause(T0 - 60)
        self.assertFalse(pause.active(T0))
        self.set_pause(None)
        self.assertFalse(pause.active(T0))
        self.path.write_text("not json")
        os.utime(self.path, ns=(time.time_ns(), time.time_ns() + 2000))
        with self.assertLogs("receiver", "WARNING"):
            self.assertFalse(pause.active(T0))


class StalePartsTest(unittest.TestCase):
    def test_only_part_files_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for name in ("20261028T053200Z.wav.part", "20261028T053300Z.wav", "20261028T053300Z.json"):
                (d / name).write_text("x")
            self.assertEqual(remove_stale_parts(d), 1)
            self.assertEqual(sorted(p.name for p in d.iterdir()), ["20261028T053300Z.json", "20261028T053300Z.wav"])

class FrameCountTest(unittest.TestCase):
    def setUp(self):
        receiver.last_counts.clear()

    def test_a_new_receiver_takes_its_first_counts_as_a_baseline(self):
        files = MinuteFiles(Path("."), RATE, 0, T0 * 1000, "board", None)
        files.health("frames_sent=360000 frames_dropped=3600")  # the board has streamed for hours
        self.assertEqual((files.sent, files.dropped), (None, None))
        files.health("frames_sent=363750 frames_dropped=3602")
        self.assertEqual((files.sent, files.dropped), (3750, 2))

    def test_counts_that_start_again_after_a_board_restart_count_in_full(self):
        files = MinuteFiles(Path("."), RATE, 0, T0 * 1000, "board", None)
        files.health("frames_sent=360000 frames_dropped=3600")
        files.health("frames_sent=8 frames_dropped=141")
        self.assertEqual((files.sent, files.dropped), (8, 141))


class ReceiverHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ota = Path(self.tmp.name)
        self.synced = self.ota / "synchronized"
        handler = type("TestHandler", (Handler,), {"token": "secret", "ota_dir": self.ota, "incoming": self.ota,
                                                   "clock_synced": self.synced})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def get(self, path, token="secret"):
        """(status, body) of a GET."""
        url = f"http://127.0.0.1:{self.server.server_address[1]}{path}"
        try:
            with urlopen(Request(url, headers={"X-Token": token}), timeout=5) as r:
                return r.status, r.read()
        except HTTPError as e:
            return e.code, e.read()

    def test_time_only_from_a_synced_clock(self):
        self.assertEqual(self.get("/time")[0], 503)
        self.synced.touch()
        status, body = self.get("/time")
        self.assertEqual(status, 200)
        self.assertAlmostEqual(int(body) / 1000, time.time(), delta=5)

    def test_time_needs_the_token(self):
        self.synced.touch()
        self.assertEqual(self.get("/time", token="wrong")[0], 403)

    def test_serves_the_image_and_its_hash(self):
        image = bytes(range(256)) * 1000
        (self.ota / "firebeetle.bin").write_bytes(image)
        self.assertEqual(self.get("/ota/firebeetle.sha256"), (200, hashlib.sha256(image).hexdigest().encode() + b"\n"))
        self.assertEqual(self.get("/ota/firebeetle.bin"), (200, image))

    def test_a_replaced_image_gets_a_new_hash(self):
        path = self.ota / "firebeetle.bin"
        path.write_bytes(b"one")
        self.get("/ota/firebeetle.sha256")
        path.write_bytes(b"two!")
        self.assertEqual(self.get("/ota/firebeetle.sha256")[1].strip(), hashlib.sha256(b"two!").hexdigest().encode())

    def test_needs_the_token(self):
        (self.ota / "firebeetle.bin").write_bytes(b"image")
        self.assertEqual(self.get("/ota/firebeetle.bin", token="wrong")[0], 403)
        self.assertEqual(self.get("/ota/firebeetle.sha256", token="")[0], 403)

    def test_no_image_or_a_bad_name_is_not_found(self):
        (self.ota / "secret.txt").write_text("x")
        self.assertEqual(self.get("/ota/firebeetle.sha256")[0], 404)
        self.assertEqual(self.get("/ota/secret.txt")[0], 404)
        self.assertEqual(self.get("/ota/../secret.bin")[0], 404)


if __name__ == "__main__":
    unittest.main()
