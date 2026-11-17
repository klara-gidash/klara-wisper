#!/bin/bash
# Builds the macOS installers for colleagues (Apple Silicon, macOS 14.4+). Touches nothing installed:
#   release/Klara Wisper.pkg  the recommended one: double-click, Install, and the app opens its install wizard
#   release/Klara Wisper.dmg  the same app to drag into Applications (KLARA_SKIP_PKG=1 builds only this)
#
# The app is self-contained: it ships the pinned uv binary and the engine's source + uv.lock. On first
# launch it installs Python and the locked packages into ~/Library/Application Support/Klara Wisper/engine
# and downloads the models (src/main/setup.ts). Nothing points at this checkout.
#
# Signing: there is no Apple Developer ID, so Gatekeeper asks once (see docs/colleagues-install.he.md).
# When the local certificate "Klara Wisper Local" exists (scripts/make-signing-identity.sh) the app is
# signed with it, so every update keeps the same identity and macOS keeps the permissions colleagues
# granted; without it the app is ad-hoc signed (permissions are asked again after each update).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

UV_VERSION=0.13.5
UV_SHA256=743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73  # same pin as setup.sh

# 1. uv, pinned and checksum-verified
if ! [ -x build/uv/uv ] || ! build/uv/uv --version | grep -q " $UV_VERSION "; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" -o "$tmp/uv.tgz"
  echo "$UV_SHA256  $tmp/uv.tgz" | shasum -a 256 -c -
  tar -xzf "$tmp/uv.tgz" -C "$tmp"
  mkdir -p build/uv && cp "$tmp/uv-aarch64-apple-darwin/uv" build/uv/uv && chmod 755 build/uv/uv
  rm -rf "$tmp"
fi

# 2. release helper (only `serve`, only for its own parent app), the app, no link to this checkout
# (built into build/colleagues/, so Klara's own build/KlaraHelper.app keeps its cdhash and permissions)
export HELPER_OUT="$ROOT/build/colleagues/KlaraHelper.app" KLARA_HELPER_APP="build/colleagues/KlaraHelper.app"
mkdir -p build/colleagues
HELPER_OUT="$HELPER_OUT" bash scripts/build-helper.sh release
npx electron-vite build
export KLARA_NO_ENGINE_PATH=1  # never point the colleagues' build at this checkout
OUT="$ROOT/dist/colleagues"
rm -rf "$OUT"
npx electron-builder --config electron-builder.config.cjs --mac --arm64 -c.directories.output="$OUT" --publish never
APP="$OUT/mac-arm64/Klara Wisper.app"

# 3. signatures, inside out: uv, the helper (its own entitlements), then the app around them
SIGN="-"
security find-certificate -c "Klara Wisper Local" >/dev/null 2>&1 && SIGN="Klara Wisper Local"
if [ "$SIGN" != "-" ]; then
  codesign --force --deep --options runtime --timestamp=none \
    --entitlements resources/entitlements.mac.plist --sign "$SIGN" "$APP"
fi
codesign --force --options runtime --timestamp=none --sign "$SIGN" "$APP/Contents/MacOS/uv"
codesign --force --options runtime --timestamp=none --sign "$SIGN" --identifier io.klara.wisper.helper \
  --entitlements native/KlaraHelper/Resources/KlaraHelper.entitlements "$APP/Contents/Resources/KlaraHelper.app"
codesign --force --options runtime --timestamp=none --sign "$SIGN" \
  --entitlements resources/entitlements.mac.plist "$APP"
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q com.apple.security.device.audio-input \
  || { echo "ERROR: the app lost its microphone entitlement" >&2; exit 1; }
npx @electron/fuses read --app "$APP" | grep -q "RunAsNode is Disabled" \
  || { echo "ERROR: Electron fuses are not locked" >&2; exit 1; }

# 4. the disk image: the app and a shortcut to /Applications
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Klara Wisper.app"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$ROOT/release"  # not dist/: scripts/dist.sh deletes that folder
DMG="$ROOT/release/Klara Wisper.dmg"
rm -f "$DMG"
# hdiutil sometimes fails with "Resource busy" (common on CI machines): try a few times, and show why.
for attempt in 1 2 3 4; do
  if hdiutil create -volname "Klara Wisper" -srcfolder "$STAGE" -fs APFS -format ULFO "$DMG"; then break; fi
  [ "$attempt" = 4 ] && { echo "ERROR: hdiutil could not create the disk image" >&2; exit 1; }
  echo "hdiutil failed (attempt $attempt), retrying in 10 s" >&2
  rm -f "$DMG"; sleep 10
done
# 5. the installer package (Klara Wisper.pkg): the same signed app, installed into /Applications by
# macOS's own Installer. It refuses a Mac that can't run the app (installer/mac-pkg/Distribution.xml),
# quits a running copy first, and opens the app when it's done, so its install wizard starts by itself.
# Files installed this way are not quarantined, so Gatekeeper asks once (for the pkg), not twice.
if [ "${KLARA_SKIP_PKG:-}" != 1 ]; then
  VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  PKGWORK="$(mktemp -d)"
  mkdir -p "$PKGWORK/root/Applications" "$PKGWORK/pkgs"
  ditto "$APP" "$PKGWORK/root/Applications/Klara Wisper.app"
  pkgbuild --analyze --root "$PKGWORK/root" "$PKGWORK/components.plist" >/dev/null
  # Never "relocate" the install onto another copy with the same bundle id (a build folder, the dmg).
  n=0
  while /usr/libexec/PlistBuddy -c "Print :$n" "$PKGWORK/components.plist" >/dev/null 2>&1; do
    /usr/libexec/PlistBuddy -c "Delete :$n:BundleIsRelocatable" "$PKGWORK/components.plist" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :$n:BundleIsRelocatable bool false" "$PKGWORK/components.plist"
    n=$((n + 1))
  done
  # The copy staged for the pkg has the installed app's identity too: keep it away from Launch Services.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -u "$PKGWORK/root/Applications/Klara Wisper.app" 2>/dev/null || true
  pkgbuild --root "$PKGWORK/root" --component-plist "$PKGWORK/components.plist" --identifier io.klara.wisper.app \
    --version "$VERSION" --install-location / --scripts installer/mac-pkg/scripts "$PKGWORK/pkgs/app.pkg"
  sed "s/@VERSION@/$VERSION/g" installer/mac-pkg/Distribution.xml >"$PKGWORK/Distribution.xml"
  PKG="$ROOT/release/Klara Wisper.pkg"
  rm -f "$PKG"
  productbuild --distribution "$PKGWORK/Distribution.xml" --resources installer/mac-pkg/resources \
    --package-path "$PKGWORK/pkgs" "$PKG"
  rm -rf "$PKGWORK"
  shasum -a 256 "$PKG"
  echo "built $PKG ($(du -h "$PKG" | cut -f1))"
fi

# Build copies share the installed app's identity: keep them away from Launch Services and Spotlight.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for stale in "$APP" "$HELPER_OUT"; do "$LSREG" -u "$stale" 2>/dev/null || true; done
rm -rf "$OUT"
touch "$ROOT/release/.metadata_never_index" "$ROOT/build/colleagues/.metadata_never_index"
shasum -a 256 "$DMG"
echo "built $DMG ($(du -h "$DMG" | cut -f1)), signed with: $SIGN"
