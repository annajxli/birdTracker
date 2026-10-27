import tempfile
import unittest
from pathlib import Path

import thresholds
from thresholds import DEFAULT_THRESHOLD, confident, learn, threshold


def reviews(sci, common, confirmed=(), rejected=()):
    return [(sci, common, c, "confirmed") for c in confirmed] + [(sci, common, c, "rejected") for c in rejected]


class LearnTest(unittest.TestCase):
    def test_reviews_on_october_27(self):
        # The indoor computer's reviews on October 27, 2026 (confidences spread within each range).
        out = learn(reviews("Haemorhous mexicanus", "House Finch", confirmed=[0.27, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 0.95])
                    + reviews("Aegolius acadicus", "Northern Saw-whet Owl", rejected=[0.5 + i / 500 for i in range(210)] + [0.99])
                    + reviews("Psaltriparus minimus", "Bushtit", confirmed=[0.34, 0.5]))
        self.assertEqual(out["Haemorhous mexicanus"]["threshold"], 0.27)
        self.assertTrue(out["Aegolius acadicus"]["blocked"])
        self.assertNotIn("Psaltriparus minimus", out)  # too few reviews: the default

    def test_threshold_is_lowest_precise_enough(self):
        # Wrong below 0.5, right above it.
        out = learn(reviews("A b", "A", confirmed=[0.5, 0.6, 0.7, 0.8, 0.9], rejected=[0.3, 0.35, 0.4, 0.45, 0.48]))
        self.assertEqual(out["A b"]["threshold"], 0.5)

    def test_one_confirmed_at_the_top_isnt_enough(self):
        out = learn(reviews("A b", "A", confirmed=[0.97], rejected=[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]))
        self.assertTrue(out["A b"]["blocked"])

    def test_lookup(self):
        species = {"A b": {"threshold": 0.3}, "C d": {"blocked": True}}
        self.assertEqual(threshold(species, "A b"), 0.3)
        self.assertIsNone(threshold(species, "C d"))
        self.assertEqual(threshold(species, "E f"), DEFAULT_THRESHOLD)
        self.assertEqual(threshold(species, None), DEFAULT_THRESHOLD)
        self.assertTrue(confident(species, "A b", 0.31))
        self.assertFalse(confident(species, "C d", 0.99))
        self.assertFalse(confident(species, "E f", 0.5))

    def test_write_and_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "thresholds.json"
            self.assertEqual(thresholds.load(path), {})
            thresholds.write(path, {"A b": {"threshold": 0.3}})
            self.assertEqual(thresholds.load(path), {"A b": {"threshold": 0.3}})


if __name__ == "__main__":
    unittest.main()
