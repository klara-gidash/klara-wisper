#!/usr/bin/env bash
# Simulates the optional Cloudflare pieces end to end, without a Cloudflare account (scripts/cloud-sim/README.md).
#   bash scripts/cloud-sim/run.sh            # everything
#   bash scripts/cloud-sim/run.sh routes     # or: team, deploy, phone, pull
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/node/bin:$PATH"

if [ ! -d node_modules/typescript ] || [ ! -d node_modules/electron ] || [ ! -d node_modules/playwright-core ]; then
  echo "The repo's node_modules (typescript, electron, playwright-core) are needed: run npm install first." >&2
  exit 1
fi

# wrangler (Cloudflare's CLI, with workerd) in a temp folder: never a dependency of the app.
DEPS="${CLOUD_SIM_DEPS:-${TMPDIR:-/tmp}/klara-cloud-sim-deps}"
if [ ! -x "$DEPS/node_modules/.bin/wrangler" ]; then
  echo "Installing wrangler into $DEPS ..."
  mkdir -p "$DEPS"
  (cd "$DEPS" && npm init -y >/dev/null && npm install --no-audit --no-fund wrangler@4 >/dev/null)
fi
export CLOUD_SIM_DEPS="$DEPS"
# The recordings the phone simulation makes, for the pull simulation.
export CLOUD_SIM_OUT="${CLOUD_SIM_OUT:-${TMPDIR:-/tmp}/klara-cloud-sim-out}"
mkdir -p "$CLOUD_SIM_OUT"

status=0
run() {
  echo
  echo "== $1 =="
  node --no-warnings "scripts/cloud-sim/$1.mjs" || status=1
}

case "${1:-all}" in
  all) for s in routes team deploy phone pull; do run "$s"; done ;;
  routes|team|deploy|phone|pull) run "$1" ;;
  *) echo "usage: $0 [all|routes|team|deploy|phone|pull]" >&2; exit 2 ;;
esac
exit $status
