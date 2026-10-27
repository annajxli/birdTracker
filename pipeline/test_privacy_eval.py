"""Evaluation metrics and score export tests, without model downloads or playback."""
import csv
from pathlib import Path
import tempfile
import unittest

import numpy as np
import soundfile as sf

from birdnet_lite import BirdNET, RATE
from privacy_eval import (candidate_spans, mask_audio, active_frames, mix_speech,
                          frame_recall, eligibility, coverage_seconds)


class CandidateTests(unittest.TestCase):
    def test_threshold_padding_merge_clamp_and_carry(self):
        self.assertEqual(candidate_spans([(0, .15), (6, .16), (59, .2)], 60, .15), [[0, 10], [58, 60]])
        self.assertEqual(candidate_spans([(3, .1499)], 60, .15), [])
        self.assertEqual(candidate_spans([], .5, .15, True), [[0, .5]])
        self.assertEqual(candidate_spans([(3, .9), (10, .9)], 60, .15), [[2, 7], [9, 14]])
        for score in [float('nan'), float('inf'), -1, 2]:
            with self.assertRaises(ValueError):
                candidate_spans([(0, score)], 60, .15)

    def test_mask_preserves_outside_length_and_smooth_edges(self):
        original = np.ones(2 * RATE, dtype=np.float32)
        muted = mask_audio(original, [[.5, 1.5]])
        np.testing.assert_array_equal(muted[:RATE // 2], original[:RATE // 2])
        np.testing.assert_array_equal(muted[3 * RATE // 2:], original[3 * RATE // 2:])
        self.assertEqual(len(muted), len(original))
        self.assertEqual(muted[RATE], 0)
        self.assertEqual(muted[RATE // 2], 1)
        self.assertLess(muted[RATE // 2 + 400], 1)
        np.testing.assert_array_equal(original, np.ones_like(original))

    def test_active_frames_and_rms_ratios(self):
        speech = np.concatenate([np.ones(RATE), np.zeros(RATE)]).astype(np.float32)
        active = active_frames(speech)
        self.assertEqual(active.sum(), 10)
        background = np.full(2 * RATE, .02, dtype=np.float32)
        for ratio in (10, 0, -10, -20):
            mixture, gain, scale = mix_speech(background, speech, active, ratio)
            recovered_voice = mixture[:RATE] * scale - background[:RATE]
            measured = 20 * np.log10(np.sqrt(np.mean(recovered_voice ** 2)) / .02)
            self.assertAlmostEqual(measured, ratio, places=3)
        self.assertEqual(frame_recall(active, [[0, .5]], 2), (.5, 1.0))
        self.assertFalse(active_frames(np.zeros(RATE)).any())
        with self.assertRaises(ValueError):
            mix_speech(np.zeros_like(background), speech, active, 0)

    def test_duplicate_exposure_cannot_supply_a_day(self):
        files = [{'timestamp': '2026-10-26T00:00:00+00:00', 'seconds': 60}] * 1440
        self.assertEqual(coverage_seconds(files), 60)
        inputs = {'background': files, 'birds': [], 'speech': [{'seconds': 200, 'voice': 'same'}] * 3}
        missing = eligibility(inputs)
        self.assertTrue(any('24 hours' in item for item in missing))
        self.assertTrue(any('voice identities' in item for item in missing))


class ScoreExportTests(unittest.TestCase):
    def test_low_voice_scores_export_without_changing_other_outputs(self):
        # Construct the wrapper without importing LiteRT or loading a model.
        net = BirdNET.__new__(BirdNET)
        net.labels = [['Bird', 'Bird'], ['Human vocal', 'Human vocal'], ['Human whistle', 'Human whistle']]
        net.voice, net.sounds = 1, np.array([1, 2])
        net.species_mask = lambda *args: np.array([True, False, False])
        net.scores = lambda chunks: np.array([[.8, .15, .05], [.1, .05, .9]])[:len(chunks)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / 'test.wav'
            sf.write(audio, np.zeros(6 * RATE, dtype=np.float32), RATE)
            results = net.analyze(audio, root, 47.61, -122.33, 40, .25)
            with results.open() as stream:
                species = list(csv.DictReader(stream))
            with (root/'test.BirdNET.sounds.csv').open() as stream:
                sounds = list(csv.DictReader(stream))
            with (root/'test.BirdNET.activity.csv').open() as stream:
                activity = list(csv.DictReader(stream))
            self.assertEqual(len(species), 1)
            self.assertEqual(species[0]['Confidence'], '0.8000')
            self.assertEqual([row['Sound'] for row in sounds], ['Whistle'])
            self.assertEqual([row['Voice'] for row in activity], ['0.1500', '0.0500'])
            self.assertEqual(activity[1]['Any bird'], '0.0000')


class HarnessTests(unittest.TestCase):
    def test_incomplete_corpus_never_selects_a_threshold(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        from privacy_eval import evaluate
        class FakeDetector:
            def __init__(self, *args):
                self.models = {"test": "no-model-loaded"}
            def score(self, path, instant=None):
                voice = .2 if path.name == 'mixture.wav' else 0
                return {"voice": [[0, voice]], "confident": [0]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            background = root / '20261026T000000Z.mp3'
            bird = root / 'bird.ogg'
            speech = root / 'voice.aiff'
            # Short, deterministic files exercise the harness, not detector accuracy.
            for path in [background, bird, speech]:
                sf.write(path, np.full(3 * RATE, .02, dtype=np.float32), RATE, format='WAV')
            item = lambda p: {"path": str(p), "seconds": 3, "timestamp": '2026-10-26T00:00:00+00:00'}
            inputs = {"background": [item(background)], "birds": [item(bird)], "speech": [item(speech)]}
            args = SimpleNamespace(out=root, lat=47.61, lon=-122.33, threads=1)
            with patch('privacy_eval.Detector', FakeDetector):
                result = evaluate(args, inputs)
            self.assertIsNone(result['selected_threshold'])
            self.assertEqual(len(result['thresholds']), 6)
            self.assertEqual(result['thresholds'][0]['speech_recall']['0'], 1)
            self.assertTrue((root/'muted-spans.csv').exists())
            self.assertEqual(len(list((root/'compare').glob('*-before.mp3'))), 2)
