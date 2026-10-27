import unittest

import numpy as np

from birdnet_lite import SOUND_MIN_CONF, any_bird, credit_siblings, rollup_pairs


class AnyBirdTest(unittest.TestCase):
    def test_faint_sound_keeps_faint_birdsong(self):
        # 9:12 AM on October 27, 2026: sparrow-like calls under an engine scoring 0.05.
        birds = np.array([0.05, 0.03, 0.02])
        self.assertAlmostEqual(any_bird(birds, 0.05), 1 - 0.95 * 0.97 * 0.98)

    def test_confident_sound_vetoes_weaker_birds(self):
        self.assertEqual(any_bird(np.array([0.3, 0.2]), SOUND_MIN_CONF), 0.0)

    def test_bird_above_a_confident_sound_counts(self):
        self.assertGreater(any_bird(np.array([0.9, 0.1]), 0.6), 0.9)

    def test_no_expected_species(self):
        self.assertEqual(any_bird(np.array([]), 0.0), 0.0)


class RollupTest(unittest.TestCase):
    NAMES = ["Aphelocoma californica", "Aphelocoma woodhouseii", "Setophaga coronata", "Setophaga townsendi",
             "Setophaga pinus", "Engine noise", "Panurus biarmicus"]

    def test_pairs(self):
        allowed = np.array([True, False, True, True, False, False, False])
        src, dst = rollup_pairs(self.NAMES, allowed, skip={5})
        # Woodhouse's credits California; the warbler genus has two expected species, so no credit;
        # Bearded Reedling has no expected relative.
        self.assertEqual(list(zip(src, dst)), [(1, 0)])

    def test_scrub_jay_at_10_15(self):
        # 10:15:00 AM on October 27, 2026: Woodhouse's 0.74, California 0.19.
        allowed = np.array([True, False, True, True, False, False, False])
        src, dst = rollup_pairs(self.NAMES, allowed)
        row = np.array([0.19, 0.74, 0.0, 0.0, 0.0, 0.0, 0.0])
        out = credit_siblings(row, src, dst)
        self.assertAlmostEqual(out[0], 0.74)
        self.assertAlmostEqual(out[1], 0.74)  # the excluded species stays excluded by the mask
        self.assertAlmostEqual(row[0], 0.19)  # the input isn't changed


if __name__ == "__main__":
    unittest.main()
