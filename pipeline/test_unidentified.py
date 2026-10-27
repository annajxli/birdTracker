import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from analyzer import read_activity, read_unidentified


class UnidentifiedTest(unittest.TestCase):
    def test_windows_match_the_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "20261027T161200Z.BirdNET.activity.csv"
            path.write_text("Start (s),Any bird,Best species\n"
                            "0.0,0.10,0.05\n"   # not birdsong
                            "3.0,0.70,0.40\n"   # unidentified
                            "6.0,0.95,0.90\n"   # a confident species
                            "9.0,0.55,0.20\n")  # unidentified
            start = datetime(2026, 10, 27, 16, 12, tzinfo=UTC)
            windows = read_unidentified(path, start)
            self.assertEqual(windows, [{"at": "2026-10-27T16:12:03Z", "seconds": 3.0},
                                       {"at": "2026-10-27T16:12:09Z", "seconds": 3.0}])
            self.assertEqual(read_activity(path), (3, len(windows)))

    def test_no_activity_file(self):
        self.assertEqual(read_unidentified(Path("/nonexistent.csv"), datetime.now(UTC)), [])


if __name__ == "__main__":
    unittest.main()
