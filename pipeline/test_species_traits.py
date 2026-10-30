"""Lengths parsed from Wikipedia sentences."""
import unittest
from species_traits import parse_length


class ParseLengthTest(unittest.TestCase):
    def test_a_name_containing_a_body_part_keeps_its_length(self):
        s = "The evening grosbeak ranges in length from 16 to 22 cm (6.3 to 8.7 in) and spans 30 to 36 cm (12 to 14 in) across the wings."
        self.assertEqual(parse_length(s)[:2], (16, 22))

    def test_a_body_part_measurement_is_skipped(self):
        self.assertIsNone(parse_length("The wing is 11 cm long."))


if __name__ == "__main__":
    unittest.main()
