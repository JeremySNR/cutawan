#!/usr/bin/env bash
# Real exports with every animated caption style, drawn by the hidden Chromium
# caption window under Xvfb with the GPU off (as CI runs). Checks decoded
# frames: captions present while words are spoken and where they belong, gone
# in the pause, the hook title, nothing else touched, and each exported frame
# matching the window's own drawing over the background. Then the libass
# fallbacks and a size-capped two-pass export. Offline, no API calls.
# Set CUTAWAN_CAPTION_BENCH=1 to also time a 60 s 1080x1920 export against libass.
# Usage: scripts/test-animated-captions.sh [output-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.tmp/animated-captions}"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
npm run build >/dev/null
CUTAWAN_USER_DATA="$OUT/profile" CUTAWAN_CAPTION_CHECK="$OUT/check" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --disable-gpu 2>&1 | grep -v -E 'dbus|Failed to connect to the bus|viz_main|gpu_' || true
test -f "$OUT/check/.passed"
echo "Animated caption check passed; frames and exports in $OUT/check"
