#!/bin/bash
# Builds "Klara Wisper.app" and installs it into /Applications.
# The Python engine and the models stay in this checkout (engine/) and ~/Library/Application Support.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
# SKIP_HELPER=1 keeps the already-signed helper, so macOS keeps its permissions.
[ "${SKIP_HELPER:-}" = 1 ] || bash scripts/build-helper.sh release
mkdir -p build && printf '%s' "$ROOT/engine" > build/engine-path.txt
npx electron-vite build
npx electron-builder --config electron-builder.config.cjs --mac --arm64
APP="dist/mac-arm64/Klara Wisper.app"
# Re-sign with the stable local certificate when it exists (see scripts/make-signing-identity.sh):
# same identity on every build, so macOS keeps the app's permissions after updates.
if security find-certificate -c "Klara Wisper Local" >/dev/null 2>&1; then
  codesign --force --deep --options runtime --timestamp=none \
    --entitlements resources/entitlements.mac.plist --sign "Klara Wisper Local" "$APP"
  codesign --verify --deep --strict "$APP"
fi
rm -rf "/Applications/Klara Wisper.app"
cp -R "$APP" /Applications/
# Only the copy in /Applications should exist for macOS: build copies share its identity and
# would confuse Launchpad/Spotlight and the privacy permissions.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for stale in dist/mac-arm64/*.app build/KlaraHelper.app; do "$LSREG" -u "$ROOT/$stale" 2>/dev/null || true; done
rm -rf dist
touch build/.metadata_never_index
echo "installed /Applications/Klara Wisper.app"
