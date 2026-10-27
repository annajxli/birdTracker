"""Evaluation metrics and score export tests, without model downloads or playback."""
import csv
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import soundfile as sf

from birdnet_lite import BirdNET, RATE
from privacy_eval import (candidate_spans, mask_audio, active_frames, mix_speech,
                          frame_recall, eligibility, coverage_seconds, long_enough,
                          prepare_librispeech)


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

    def test_speech_skips_short_background_minutes(self):
        files = [{'path': 'a', 'seconds': 60}, {'path': 'short', 'seconds': 39}, {'path': 'c', 'seconds': 60}]
        self.assertEqual(long_enough(files, 1, 58)['path'], 'c')
        self.assertEqual(long_enough(files, 2, 58)['path'], 'c')
        self.assertEqual(long_enough(files, 3, 58)['path'], 'a')
        with self.assertRaises(ValueError):
            long_enough(files, 0, 61)

    def test_librispeech_speakers_become_voice_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for speaker in ('84', '174'):
                chapter = root / 'src' / speaker / '1'
                chapter.mkdir(parents=True)
                for n in range(3):
                    sf.write(chapter / f'{speaker}-1-{n:04d}.flac', np.full(16000 * 4, 0.1, np.float32), 16000)
            prepare_librispeech(root / 'src', root / 'speech', seconds=6)
            identities = json.loads((root / 'speech' / 'synthesis.json').read_text())
            self.assertEqual([x['voice'] for x in identities], ['LibriSpeech speaker 84', 'LibriSpeech speaker 174'])
            self.assertAlmostEqual(sf.info(root / 'speech' / 'librispeech-84.flac').duration, 8.6, places=2)

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


class ReportTests(unittest.TestCase):
    def test_new_results_preserve_earlier_records(self):
        from privacy_eval import report
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.md'
            inputs = {'background': [], 'birds': [], 'speech': []}
            result = {'thresholds': [], 'selected_threshold': None, 'limitations': ['incomplete corpus']}
            report(path, inputs, result)
            original = path.read_text()
            report(path, inputs, result)
            updated = path.read_text()
            self.assertTrue(updated.startswith(original))
            self.assertEqual(updated.count('## Evaluation '), 2)
