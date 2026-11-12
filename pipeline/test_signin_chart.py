import re
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

import db
from signin_chart import birdsong_days, chart, weather_kind


def detection(when, confidence=0.9, species=("Troglodytes pacificus", "Pacific Wren"), review=None, source="r.wav"):
    return {"station_id": "b", "detected_at": when, "scientific_name": species[0], "common_name": species[1],
            "confidence": confidence, "clip_path": None, "source_file": source, "review": review}


class BirdsongDaysTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(Path(self.tmp.name) / "d.sqlite")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def add(self, *rows):
        for r in rows:
            self.conn.execute(f"INSERT INTO detections ({', '.join(r)}) VALUES ({', '.join('?' * len(r))})", tuple(r.values()))
        self.conn.commit()

    def test_counts_distinct_minutes_of_kept_detections(self):
        # November 10, 2026, Pacific (UTC-8): two species in one minute count once.
        self.add(detection("2026-11-10T17:00:05Z"), detection("2026-11-10T17:00:40Z", species=("Junco hyemalis", "Dark-eyed Junco")),
                 detection("2026-11-10T17:05:00Z"),
                 detection("2026-11-10T17:09:00Z", confidence=0.3),  # below the threshold
                 detection("2026-11-10T17:10:00Z", review="rejected"),
                 detection("2026-11-10T17:11:00Z", confidence=0.3, review="confirmed"))  # confirmed counts, as on the dashboard
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12)), [("2026-11-10", 3)])

    def test_uses_pacific_dates_and_skips_today(self):
        # 03:00 UTC on November 11 is the evening of November 10 in Seattle.
        self.add(detection("2026-11-11T03:00:00Z"), detection("2026-11-12T18:00:00Z"))
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12)), [("2026-11-10", 1)])

    def test_counts_both_passes_through_the_repeated_hour(self):
        # Daylight time ended at 2 AM on November 1, 2026: 08:58 and 09:58 UTC are both 1:58 AM in Seattle.
        self.add(detection("2026-11-01T08:58:00Z"), detection("2026-11-01T09:58:00Z"))
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12)), [("2026-11-01", 2)])

    def test_keeps_the_last_recorded_days_back_to_back(self):
        # Recorded on the 1st, 2nd, and 9th; nothing between. A day with only weak detections still counts as recorded.
        self.add(detection("2026-11-01T18:00:00Z"), detection("2026-11-02T18:00:00Z"),
                 detection("2026-11-09T18:00:00Z", confidence=0.2))
        self.assertEqual(birdsong_days(self.conn, 0.6, 2, date(2026, 11, 12)), [("2026-11-02", 1), ("2026-11-09", 0)])

    def test_leaves_out_simulated_detections(self):
        self.add(detection("2026-11-10T18:00:00Z", source="simulated"))
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12)), [])
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12), allow_simulated=True), [("2026-11-10", 1)])

    def test_empty_database(self):
        self.assertEqual(birdsong_days(self.conn, 0.6, 14, date(2026, 11, 12)), [])


class ChartTest(unittest.TestCase):
    DAYS = [("2026-10-30", 117), ("2026-10-31", 0), ("2026-11-07", 139)]
    WEATHER = {"2026-10-30": {"temp_max_f": 48, "temp_min_f": 40, "precip_in": 0.185, "weather_code": 61},
               "2026-11-07": {"temp_max_f": 53, "temp_min_f": 35, "precip_in": 0.0, "weather_code": 45}}

    def test_has_no_dates(self):
        svg = chart(self.DAYS, self.WEATHER)
        self.assertIsNone(re.search(r"20\d\d-\d\d|Oct|Nov", svg))

    def test_draws_a_bar_per_nonzero_day_and_an_icon_per_weather_day(self):
        svg = chart(self.DAYS, self.WEATHER)
        self.assertEqual(svg.count('class="bar"'), 2)
        self.assertEqual(len(re.findall(r'class="icon icon-', svg)), 2)
        self.assertIn("<title>Rain, 40–48°F</title>", svg)
        self.assertIn("<title>117 minutes of birdsong</title>", svg)
        self.assertIn(">Birdsong (min/day)<", svg)
        self.assertIn(">High–low (°F)<", svg)

    def test_without_weather_leaves_out_the_temperature_band(self):
        svg = chart(self.DAYS, {})
        self.assertNotIn("High–low", svg)
        self.assertNotIn("icon", svg)
        self.assertTrue(svg.startswith("<svg") and svg.endswith("</svg>"))

    def test_weather_kinds(self):
        self.assertEqual(weather_kind(0, 0), ("clear", 0))
        self.assertEqual(weather_kind(53, 0.05), ("drizzle", 1))
        self.assertEqual(weather_kind(63, 0.5), ("rain", 3))
        self.assertEqual(weather_kind(3, 0), ("cloud", 0))


if __name__ == "__main__":
    unittest.main()
