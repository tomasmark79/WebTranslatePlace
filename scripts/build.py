#!/usr/bin/env python3
"""Build browser-specific packages from the shared extension sources."""

import argparse
import json
from pathlib import Path
import shutil
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ("chrome", "firefox", "safari", "epiphany")
RUNTIME_FILES = (
    "background.js", "content.js", "selection.js", "api-settings.js", "popup.js", "popup.html", "popup.css",
    "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
)


def make_manifest(target):
    manifest = json.loads((ROOT / "manifests/base.json").read_text(encoding="utf-8"))
    manifest.update(json.loads((ROOT / "manifests" / f"{target}.json").read_text(encoding="utf-8")))
    if target == "epiphany":
        manifest["permissions"] += manifest.pop("host_permissions")
        manifest["browser_action"] = manifest.pop("action")
    return manifest


def build(target, output_root):
    manifest = make_manifest(target)
    output_root.mkdir(parents=True, exist_ok=True)
    output = output_root / target
    # Recreate only this generated target, so removed sources cannot linger.
    with tempfile.TemporaryDirectory(prefix=f".{target}-", dir=output_root) as staging:
        stage = Path(staging)
        for name in RUNTIME_FILES:
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "src" / name, destination)
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        suffix = "xpi" if target == "epiphany" else "zip"
        package = output_root / f'webtranslateplace-{target}-{manifest["version"]}.{suffix}'
        with ZipFile(package, "w", ZIP_DEFLATED) as archive:
            for name in sorted(("manifest.json", *RUNTIME_FILES)):
                # Fixed metadata makes identical sources produce identical archives.
                info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, (stage / name).read_bytes())
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    print(package)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", metavar="TARGET",
                        help="chrome, firefox, safari or epiphany (default: all)")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist",
                        help="Directory for generated extensions and archives")
    args = parser.parse_args()
    targets = args.targets or list(TARGETS)
    for target in targets:
        if target not in TARGETS:
            parser.error(f"Unknown target: {target}")
    output_root = args.output_dir.resolve()
    # Never allow cleanup of a generated target to replace source directories.
    if output_root == ROOT or output_root in ROOT.parents or output_root == ROOT / "src":
        parser.error("Output directory must not replace the project or its sources")
    for target in dict.fromkeys(targets):
        build(target, output_root)


if __name__ == "__main__":
    main()
