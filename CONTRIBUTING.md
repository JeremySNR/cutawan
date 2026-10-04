# Contributing to Cutawan

Thanks for looking. Cutawan is a TypeScript Electron app and contributions are
genuinely welcome, whether that is a bug report, a caption style or a new
pipeline stage.

## Getting set up

You need **Node.js 20+**. FFmpeg is bundled, so there is nothing else to
install.

```bash
git clone https://github.com/JeremySNR/cutawan.git
cd cutawan
npm install
npm run dev
```

Most of the app works without an API key. Clip analysis can use an
[OpenAI-compatible API](https://platform.openai.com/api-keys) or the optional
[ChatGPT/Codex connection](docs/chatgpt-subscription.md); whole-video captions
can run with local Whisper and no AI connection. See the
[getting-started guide](docs/getting-started.md) for the three first-run paths.
If you want to explore the UI without spending anything, seed a demo project instead:

```bash
npx tsx --tsconfig tsconfig.node.json scripts/seed-demo.ts
```

## Before you open a PR

These three must pass, and CI enforces all of them plus an offline render test
and a UI smoke test:

```bash
npm test          # vitest
npm run typecheck # both tsconfigs, node and web
npm run lint      # eslint
```

### Release notes

Every change people will notice needs a line in `CHANGELOG.md` under
`## [Unreleased]`, grouped as `### Added`, `### Improved` or `### Fixed`. CI
fails a pull request that changes `src/`, `resources/` or `package.json`
without one. For internal-only changes (tests, CI, docs, refactors with no
visible effect), add the `no release notes` label instead.

These lines are what people read: the release workflow publishes a version's
section as its GitHub release notes, the app shows the same text in Settings →
Updates before someone updates, and again as "What's new" after they do. So
write them for someone using Cutawan, not for a code reviewer:

- Say what changed for them: "Clips appear as soon as they're scored" rather
  than "Move eager reframe out of analyzeProject".
- One change per bullet, plain words, no file or function names.
- Measurements, failed trials and limits go in a `### Validation` section (or
  a doc linked from it). It appears on GitHub but not in the app.

To release, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` in the same
commit as the version bump. The release workflow refuses to build a version
with no notes.

## How the code is laid out

`README.md` has the full tree. The short version:

- `src/main/` is the Electron main process. `src/main/pipeline/` is where
  transcription, clip detection, face tracking and rendering live.
- `src/shared/` is the important one. Caption layout, tighten-cuts and zoom
  planning all live here **because the live preview and the export both use
  them**. If you change planning logic, change it here or the preview and the
  rendered file will disagree.
- `src/renderer/` is the React UI (Tailwind, Zustand).
- `src/preload/` is the typed, context-isolated bridge. IPC handlers are in
  `src/main/ipc.ts`.

`AGENTS.md` has notes aimed at AI coding agents, and is worth a read for humans
too.

## Testing changes to the pipeline

Unit tests cover the planners and pure logic. For anything that touches ffmpeg
or rendering, the standalone scripts in `scripts/` are the real check:

```bash
npx tsx --tsconfig tsconfig.node.json scripts/test-pipeline.ts   # offline
./scripts/smoke-test.sh .tmp/smoke                               # Xvfb, Linux
```

`test-pipeline`, `test-handoff`, `test-quality`, `test-encoders`, `test-resilience`,
`test-wholevideo`, `test-captionsize` and `test-uploadsize` run offline.
`test-e2e`, `test-broll` and `test-youtube` need network or an API key. Each
file's header says what it covers.

## Things that are easy to get wrong

- **Preview and export must match.** Anything affecting what the viewer sees
  belongs in `src/shared/`, used by both paths.
- **Caption sizing is not CSS sizing.** libass sizes text against the font's
  OS/2 window ascent plus descent, not the em square. Use `assFontSize`.
- **Don't log auth values.** API keys, session cookies and CSRF tokens must
  never reach a log line or an error message.
- **Long videos are the hard case.** Chunking, checkpointing and progress
  reporting all matter more than they look. Test with something over an hour if
  you touch transcription.

## Reporting bugs

Open an issue with the template. The app version, your OS, and the console
output (View → Toggle Developer Tools) are what make a report actionable.

If you think you have found a security issue, please read
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md). In
short: be kind, assume good faith.

## Style

- TypeScript throughout, no `any` without a comment explaining why.
- Comments explain **why**, not what. Match the density of the file you are in.
- British English in prose and comments.
