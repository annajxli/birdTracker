"""Known impulses must land at their actual time within the displayed full duration."""
import unittest
import numpy as np
from spectrogram import spectrogram


class TimingTest(unittest.TestCase):
    def test_full_duration_pixel_centers_match_impulse_times(self):
        for rate in (16000, 24000, 32000, 48000):
            for seconds in (.08, 1.013, 3):
                for fraction in (.02, .25, .5, .9, .98):
                    with self.subTest(rate=rate, seconds=seconds, fraction=fraction):
                        data = np.zeros(int(rate * seconds))
                        sample = min(len(data) - 1, int(len(data) * fraction))
                        data[sample] = 1
                        image = spectrogram(data, rate)
                        peak = np.argmax(image.max(axis=0))
                        displayed_time = (peak + .5) * (len(data) / rate) / image.shape[1]
                        self.assertLessEqual(abs(displayed_time - sample / rate), .011)

    def test_empty_audio_is_rejected(self):
        with self.assertRaises(ValueError):
            spectrogram(np.zeros(0), 32000)


if __name__ == '__main__':
    unittest.main()
