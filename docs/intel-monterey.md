# Intel macOS Monterey build

This fork adds a standalone Intel (x86_64) packaging workflow. Upstream Cutawan currently publishes Apple Silicon macOS builds, not Intel Mac installers.

## Build from GitHub without using the 4 GB MacBook to compile

1. Open **Actions** in this fork.
2. Open **Intel macOS build (Monterey)**.
3. Select **Run workflow** on the branch where the workflow is present (after this PR merges, use `main`).
4. Wait for the job to complete successfully, then open the workflow run and download the `Cutawan-Intel-Monterey-x64` artifact.
5. Extract the artifact ZIP and check its `SHA256SUMS-intel.txt` hashes. Mount the `.dmg` and drag `Cutawan.app` to Applications.

The app is ad-hoc signed, **not** Developer ID-signed or notarized. Gatekeeper may require you to verify the download and use **System Settings > Privacy & Security > Open Anyway**. Do not blindly disable security protections.

## What CI verifies

- The installer was built on an Intel GitHub runner using Node.js 22.
- The packaged app and Electron Framework are x86_64.
- The packaged app passes `codesign --verify --deep --strict`.
- Cutawan's packaged-media pipeline, setup wizard and updater smoke checks run.
- Downloadable DMG and ZIP files plus SHA-256 checksums are produced.

**Limit:** macOS 15 is the CI runner. A successful CI build is *not* proof that every binary works on macOS Monterey (12), or that 4 GB RAM is sufficient for long-video CPU transcription. Test on the real Monterey Intel Mac before promoting a release.

## First real-device test

1. Check **About This Mac** to confirm the Intel processor, Monterey version, and free disk space.
2. Import a short, locally stored MP4, then run **Caption whole video** with a small local Whisper model or a supported cloud provider.
3. Try **Find viral clips** with a configured Codex/OpenAI-compatible/OpenRouter connection. Local captions-only mode does not run highlight selection.
4. Export one vertical 9:16 MP4, play it back, and verify audio/video sync, timestamps and caption positioning.
5. Repeat with a 15–20 minute interview while watching Activity Monitor memory pressure. Avoid the large Whisper model on 4 GB RAM.

## Keep this fork separate from upstream releases

The existing `package.json` still points the electron-builder publisher to `JeremySNR/cutawan`, and the existing release workflow assumes that repository's versioned release process. This new workflow **does not publish releases** and uses `--publish never`. Before distributing our own updates, change the publisher to `MandlaLee/cutawan` and review the app's update-check behaviour, changelog and release validation together.

MIT licence notices and upstream attribution must remain.
