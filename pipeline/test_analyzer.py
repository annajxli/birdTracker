"""Analyzer failure handling: what counts against a recording, and what doesn't."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import analyzer
import birdnet_lite
import db


class ModelLoadTest(unittest.TestCase):
    def test_a_model_that_wont_load_leaves_recordings_in_incoming(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "incoming").mkdir()
            audio = data / "incoming" / "20261031T000000Z.wav"
            audio.write_bytes(b"RIFF")
            old = time.time() - 60
            os.utime(audio, (old, old))
            args = SimpleNamespace(data=data, engine="lite", threads=1, station="b", lat=47.6, lon=-122.3,
                                   min_conf=0.25, keep_days=0, live_hours=0)
            conn = db.connect(data / "d.sqlite")
            self.addCleanup(conn.close)
            state = {"snapshot": analyzer.snapshot(data / "incoming")}
            with patch.object(analyzer, "_lite", None), patch.object(birdnet_lite, "BirdNET", side_effect=ValueError("Could not open model")):
                for _ in range(analyzer.MAX_ATTEMPTS + 1):
                    with self.assertRaises(analyzer.EnvironmentProblem):
                        analyzer.run_once(args, conn, state)
            self.assertTrue(audio.exists())
            self.assertEqual(list((data / "failed").iterdir()), [])
            self.assertEqual(state["attempts"], {})


if __name__ == "__main__":
    unittest.main()
