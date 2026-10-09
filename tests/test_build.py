"""Validate browser packages, shared runtime files and rebuild behavior."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="webtranslateplace-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "dist"

    def build(self, *targets):
        subprocess.run([sys.executable, str(ROOT / "scripts/build.py"),
                        "--output-dir", str(self.output), *targets],
                       check=True, capture_output=True)

    def test_all_packages_share_runtime_and_have_valid_entry_points(self):
        self.build()
        expected_files = {"manifest.json", "background.js", "content.js", "selection.js", "api-settings.js",
                          "popup.js", "popup.html", "popup.css", "icons/icon16.png", "icons/icon32.png",
                          "icons/icon48.png", "icons/icon128.png"}
        self.assertEqual(len(list(self.output.glob("webtranslateplace-*"))), 5)
        for target in ("chrome", "firefox", "safari", "epiphany"):
            with self.subTest(target=target):
                directory = self.output / target
                manifest = json.loads((directory / "manifest.json").read_text())
                suffix = "xpi" if target == "epiphany" else "zip"
                with ZipFile(self.output / f'webtranslateplace-{target}-{manifest["version"]}.{suffix}') as archive:
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(set(archive.namelist()), expected_files)
                    for name in expected_files:
                        self.assertEqual(archive.read(name), (directory / name).read_bytes())
                        if name != "manifest.json":
                            self.assertEqual(archive.read(name), (ROOT / "src" / name).read_bytes())
                action = manifest.get("action", manifest.get("browser_action"))
                self.assertTrue((directory / action["default_popup"]).is_file())
                self.assertTrue((directory / manifest["options_ui"]["page"]).is_file())
                discord_script, selection_script = manifest["content_scripts"]
                self.assertEqual(discord_script["matches"], [
                    "*://discord.com/*", "*://canary.discord.com/*", "*://ptb.discord.com/*"])
                self.assertEqual(discord_script["js"], ["content.js"])
                self.assertFalse(discord_script.get("all_frames", False))
                self.assertEqual(selection_script["js"], ["selection.js"])
                for script in manifest["content_scripts"]:
                    for name in script["js"]:
                        self.assertTrue((directory / name).is_file())
                if target == "chrome":
                    self.assertEqual(manifest["background"], {"service_worker": "background.js"})
                else:
                    self.assertEqual(manifest["background"]["scripts"], ["background.js"])
                    self.assertNotIn("service_worker", manifest["background"])
                if target == "firefox":
                    self.assertEqual(manifest["browser_specific_settings"]["gecko"]["id"],
                                     "webtranslateplace@tomasmark79")
                self.assertIn("translate-selection-secondary", manifest["commands"])
                shortcut = manifest["commands"]["translate-selection"]["suggested_key"]
                self.assertEqual(shortcut["default"], "Ctrl+Alt+S" if target == "firefox" else "Alt+Shift+S")
                self.assertEqual(shortcut["mac"], "Command+Alt+S" if target == "firefox" else "Alt+Shift+S")
                if target == "epiphany":
                    self.assertEqual(manifest["manifest_version"], 2)
                    self.assertNotIn("action", manifest)
                    self.assertNotIn("host_permissions", manifest)
                    self.assertIn("<all_urls>", manifest["permissions"])
                    self.assertNotIn("optional_permissions", manifest)
                else:
                    self.assertEqual(manifest["manifest_version"], 3)
                    self.assertIn("<all_urls>", manifest["host_permissions"])
                    self.assertNotIn("optional_host_permissions", manifest)

    def test_thunderbird_package_and_mail_entry_points(self):
        self.build("thunderbird")
        directory = self.output / "thunderbird"
        manifest = json.loads((directory / "manifest.json").read_text())
        self.assertEqual(manifest["manifest_version"], 2)
        self.assertNotIn("content_scripts", manifest)
        self.assertNotIn("host_permissions", manifest)
        self.assertNotIn("action", manifest)
        self.assertIn("compose", manifest["permissions"])
        self.assertIn("messagesModify", manifest["permissions"])
        self.assertNotIn("messagesRead", manifest["permissions"])
        self.assertEqual(manifest["browser_specific_settings"]["gecko"]["strict_min_version"], "128.0")
        for action in ("browser_action", "compose_action", "message_display_action"):
            self.assertTrue((directory / manifest[action]["default_popup"]).is_file())
        archive_path = next(self.output.glob("*thunderbird*.xpi"))
        with ZipFile(archive_path) as archive:
            self.assertIsNone(archive.testzip())
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (directory / name).read_bytes())
            for name in manifest["background"]["scripts"]:
                self.assertIn(name, archive.namelist())
            for name in ("thunderbird-compose.js", "thunderbird-message.js", "selection.js"):
                self.assertEqual(archive.read(name), (ROOT / "src" / name).read_bytes())
        before = archive_path.read_bytes()
        self.build("thunderbird")
        self.assertEqual(before, archive_path.read_bytes())

    def test_rebuild_is_reproducible_and_removes_stale_runtime_files(self):
        self.build("chrome")
        archive = next(self.output.glob("*.zip"))
        before = archive.read_bytes()
        stale = self.output / "chrome/removed-script.js"
        stale.write_text("stale")
        self.build("chrome")
        self.assertFalse(stale.exists())
        self.assertEqual(archive.read_bytes(), before)
        self.assertFalse((self.output / "firefox").exists())

    def test_unknown_target_fails_before_writing_outputs(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/build.py"),
                                 "chrome", "unknown", "--output-dir", str(self.output)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unknown target", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
