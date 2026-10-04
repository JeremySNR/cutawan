# AGENTS.md

## Cursor Cloud specific instructions

Cutawan is a single **Electron + Vite + React + TypeScript** desktop app (npm, Node 20+). There is no backend server, database, or container to start — the only external service is the OpenAI API. Standard commands live in `README.md` and `package.json` scripts; this section only captures non-obvious cloud caveats.

### Environment already provided
- `npm install` is handled by the startup update script — dependencies (including bundled `ffmpeg-static`, `ffprobe-static`, and the `onnxruntime-node` native binary) are already installed on session start.
- `OPENAI_API_KEY` is injected as a secret and is required for the AI stages (Whisper transcription + LLM highlight/scoring/B-roll). Optionally override the endpoint with `OPENAI_BASE_URL`.
- `xvfb` (`xvfb-run`) is available for running the GUI headlessly.

### Running the GUI headlessly (no physical display)
- This is a desktop Electron app; there is no web URL. To launch it in a headless VM, wrap it in Xvfb and disable the sandbox/GPU:
  `xvfb-run -a --server-args="-screen 0 1600x1000x24" npx electron . --no-sandbox --disable-gpu`
  (Requires a prior `npm run build` so `out/` exists.) `npm run dev` also works but expects a display.
- Harmless `Failed to connect to the bus` (DBus) and GPU warnings are expected under Xvfb and can be ignored.
- `scripts/smoke-test.sh [out-dir]` is the fastest end-to-end GUI check: it builds, seeds a demo project via `scripts/seed-demo.ts`, launches under Xvfb with `CUTAWAN_SMOKE` set, and writes the first-run wizard shots (`setup-wizard.png` plus `setup-openrouter*.png`, which read the sample catalogue in `tests/fixtures/openrouter-catalog.json` because the walk is offline), `home.png`, `clips.png`, `editor.png`, `setup-clips.png`, `setup-caption-video.png`, `editor-caption-video.png`, `settings.png` and `settings-export.png` screenshots, then launches once more with `--import-package tests/fixtures/metachlorian-package` and writes `package-import.png`. The walk assumes a freshly seeded demo project (the script seeds one every run), and it runs "caption whole video" for real using the seeded transcript, so it makes no API calls. Set `CUTAWAN_SMOKE` to an output dir to trigger this auto-screenshot-and-exit mode.

### Tests / lint
- `npm test` (vitest), `npm run typecheck` and `npm run lint` (eslint) are the static gates, and CI enforces all three on every push. Run them before proposing a change.
- On top of those, the `scripts/test-*.ts` files are standalone `tsx` integration scripts (see `README.md` "Tests"). Run them via `npx tsx --tsconfig tsconfig.node.json scripts/<name>.ts`.
- Tests that hit OpenAI (`test-e2e.ts`, `test-broll.ts`) need `OPENAI_API_KEY`; `test-pipeline.ts`, `test-handoff.ts`, `test-resilience.ts`, `test-encoders.ts`, `test-quality.ts` run fully offline.

### Metachlorian handoff
- `cutawan --import-package "<dir-or-zip>"` (from source: `npx electron . --import-package "<path>"`) imports a Metachlorian package and opens it; a second launch forwards the path to the running app. See `docs/metachlorian-handoff.md`. `CUTAWAN_SELECT_PACKAGE` skips the "Import Metachlorian package…" dialog in headless runs.

### Persistence
- Projects and encrypted settings are stored in Electron `userData` (`~/.config/cutawan/` on Linux), not in the repo. Delete that dir to reset app state.
