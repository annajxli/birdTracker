"""Checks for the update report: apt's simulated upgrade, and the deployed code's fingerprint."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import code_version
from publish import Health
from updates import parse

SIMULATION = """\
Inst libssl3t64 [3.5.1-1] (3.5.1-1+deb13u1 Debian-Security:13/stable-security [arm64])
Inst tzdata [2025b-4] (2025b-4+deb13u1 Debian:13.2/stable [all])
Inst linux-image-rpi-v8 (1:6.12.47-1+rpt1 Raspberry Pi Foundation:stable [arm64])
Conf libssl3t64 (3.5.1-1+deb13u1 Debian-Security:13/stable-security [arm64])
"""


class UpdatesTest(unittest.TestCase):
    def test_parse_counts_packages_and_security(self):
        packages = parse(SIMULATION)
        self.assertEqual([p["name"] for p in packages], ["libssl3t64", "tzdata", "linux-image-rpi-v8"])
        self.assertEqual([p["security"] for p in packages], [True, False, False])
        self.assertEqual(packages[0]["from"], "3.5.1-1")
        self.assertIsNone(packages[2]["from"])  # a new package

    def test_status_includes_code_and_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "updates.json").write_text(json.dumps({"upgradable": 3}))
            self.assertEqual(Health(data).snapshot()["updates"], {"upgradable": 3})


class CodeVersionTest(unittest.TestCase):
    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def test_working_tree_matches_commit_with_same_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.root = root = Path(tmp)
            self.git("init", "-q")
            self.git("config", "user.email", "test@example.com")
            self.git("config", "user.name", "Test")
            (root / "pipeline").mkdir()
            (root / "pipeline" / "a.py").write_text("one\n")
            (root / "README.md").write_text("not deployed\n")
            self.git("add", ".")
            self.git("commit", "-qm", "first")
            first = code_version.fingerprint_at("HEAD", root)
            self.assertEqual(code_version.fingerprint(root), first)

            (root / "README.md").write_text("changed, still not deployed\n")
            self.assertEqual(code_version.fingerprint(root), first)
            (root / "pipeline" / "a.py").write_text("two\n")
            self.assertNotEqual(code_version.fingerprint(root), first)
            self.git("commit", "-qam", "second")
            self.assertEqual(code_version.fingerprint(root), code_version.fingerprint_at("HEAD", root))


if __name__ == "__main__":
    unittest.main()
