#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Safari packaging requires macOS and Xcode.' >&2
  exit 1
fi
if [[ ! -f "$project_root/dist/safari/manifest.json" ]]; then
  echo 'Run python3 scripts/build.py first, or copy the built dist/safari directory here.' >&2
  exit 1
fi

if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  packager=safari-web-extension-packager
elif xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  packager=safari-web-extension-converter
else
  echo 'Safari extension packager was not found. Install/select Xcode first.' >&2
  exit 1
fi

# Do not overwrite an existing Xcode project; the packager handles collisions.
xcrun "$packager" "$project_root/dist/safari" \
  --project-location "$project_root/SafariProject" \
  --app-name WebTranslatePlace \
  --bundle-identifier com.tomasmark79.webtranslateplace \
  --macos-only --copy-resources --no-open
