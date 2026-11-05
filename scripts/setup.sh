#!/bin/bash
# One-time setup on a new Mac (Apple Silicon, macOS 14.4+, Xcode Command Line Tools).
# Installs Node and uv into ~/.local (no sudo, no Homebrew), the engine's Python packages,
# the models (~5 GB), builds the native helper and installs the app into /Applications.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION=v24.22.1
UV_VERSION=0.13.5
# Pinned checksums (verified against the official release pages when these versions were chosen).
NODE_SHA256=654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628
UV_SHA256=743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

if ! command -v node >/dev/null; then
  f="node-$NODE_VERSION-darwin-arm64.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$f" -o "$tmp/$f"
  echo "$NODE_SHA256  $tmp/$f" | shasum -a 256 -c -
  mkdir -p "$HOME/.local/node" && tar -xJf "$tmp/$f" -C "$HOME/.local/node" --strip-components=1
fi
if ! command -v uv >/dev/null; then
  tmp="$(mktemp -d)"
  base="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz"
  curl -fsSL "$base" -o "$tmp/uv.tgz"
  echo "$UV_SHA256  $tmp/uv.tgz" | shasum -a 256 -c -
  tar -xzf "$tmp/uv.tgz" -C "$tmp" && cp "$tmp"/uv-aarch64-apple-darwin/uv* "$HOME/.local/bin/"
fi

cd "$ROOT/engine"
uv python install 3.12
uv sync --locked
.venv/bin/python -m klara_engine.models download all

cd "$ROOT"
npm ci
bash scripts/build-helper.sh
bash scripts/dist.sh
