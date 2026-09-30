#!/usr/bin/env bash
# Builds the app, seeds a demo project, launches under Xvfb and captures
# screenshots of the first-run wizard and every main screen, including both
# project modes and a real "caption whole video" run (offline: the seeded
# project has a transcript).
# Usage: scripts/smoke-test.sh [output-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.tmp/smoke}"
mkdir -p "$OUT"
npm run build >/dev/null
SMOKE_OUT="$(realpath "$OUT")"
# The OpenRouter pickers read a saved sample catalogue so the walk needs no network.
CUTAWAN_USER_DATA="$SMOKE_OUT/wizard-profile" CUTAWAN_SMOKE="$SMOKE_OUT" CUTAWAN_SMOKE_WIZARD=1 \
  CUTAWAN_OPENROUTER_CATALOG="$(realpath tests/fixtures/openrouter-catalog.json)" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --disable-gpu
npx tsx --tsconfig tsconfig.node.json scripts/seed-demo.ts
CUTAWAN_SMOKE="$SMOKE_OUT" xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --disable-gpu
echo "Screenshots written to $OUT"
