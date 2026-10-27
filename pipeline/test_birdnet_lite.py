import unittest

import numpy as np

from birdnet_lite import SOUND_MIN_CONF, any_bird


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


if __name__ == "__main__":
    unittest.main()
