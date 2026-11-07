#!/bin/bash
# Installs uv on a CI machine (GitHub Actions macos-14, Apple Silicon): the same pinned version and
# SHA-256 as the app build, read from scripts/make-dmg.sh so there is one pin to update.
# Puts uv on PATH for the next steps ($GITHUB_PATH). Usage: bash scripts/ci/install-uv.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

UV_VERSION="$(sed -nE 's/^UV_VERSION=([0-9.]+).*/\1/p' "$ROOT/scripts/make-dmg.sh" | head -1)"
UV_SHA256="$(sed -nE 's/^UV_SHA256=([0-9a-f]{64}).*/\1/p' "$ROOT/scripts/make-dmg.sh" | head -1)"
[[ "$UV_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ERROR: no UV_VERSION in scripts/make-dmg.sh" >&2; exit 1; }
[[ "$UV_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "ERROR: no UV_SHA256 in scripts/make-dmg.sh" >&2; exit 1; }
[ "$(uname -sm)" = "Darwin arm64" ] || { echo "ERROR: the pin is for uv-aarch64-apple-darwin, this is $(uname -sm)" >&2; exit 1; }

DEST="${RUNNER_TEMP:-$(mktemp -d)}/uv-bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" -o "$tmp/uv.tgz"
echo "$UV_SHA256  $tmp/uv.tgz" | shasum -a 256 -c -
tar -xzf "$tmp/uv.tgz" -C "$tmp"
mkdir -p "$DEST"
cp "$tmp/uv-aarch64-apple-darwin/uv" "$DEST/uv"
chmod 755 "$DEST/uv"
"$DEST/uv" --version
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >>"$GITHUB_PATH"; else echo "add $DEST to PATH"; fi
