"""Tests for analyze_ppk2.py. To run them: python3 -m unittest firmware/power_test/test_analyze_ppk2.py"""

import unittest

import analyze_ppk2


class Summarize(unittest.TestCase):
    def rows(self, stretches, group):
        samples = []
        t = 0.0
        for code, ua, n in stretches:
            for _ in range(n):
                samples.append((t, ua, code))
                t += 1.0
        return analyze_ppk2.summarize(list(analyze_ppk2.segments(samples)), group, 3.7)

    def test_names_each_state_and_skips_gaps(self):
        rows = self.rows([(0, 9, 3), (1, 50000, 11), (0, 9, 3), (2, 120000, 11), (0, 9, 3)], 2)
        self.assertEqual([r["state"] for r in rows], ["S3", "S9"])
        self.assertEqual(rows[0]["mean_ua"], 50000)
        self.assertAlmostEqual(rows[0]["mean_mw"], 185.0)

    def test_sleep_is_the_low_stretch_between_its_codes(self):
        rows = self.rows([(0, 9, 2), (7, 40000, 3), (0, 15, 301), (7, 40000, 3), (0, 9, 2)], 3)
        self.assertEqual([(r["state"], r["mean_ua"]) for r in rows], [("S2", 15)])

    def test_energy_uses_the_stretch_length(self):
        rows = self.rows([(1, 1000, 11), (0, 0, 1)], 2)
        self.assertAlmostEqual(rows[0]["energy_mj"], 1000e-6 * 11 * 3.7 * 1e3, places=2)


if __name__ == "__main__":
    unittest.main()
