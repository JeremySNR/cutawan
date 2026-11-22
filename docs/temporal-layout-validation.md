# Targeting brief crop failures

This increment improves temporal evidence for screen/presenter layouts. It does not establish arbitrary-video quality or complete the adaptive-clipping roadmap.

## Behavior and bounds

- Detect large screen changes before composing, including when editorial analysis supplied panels. Discard the whole-clip panel proposal when a transition requires separate shots, avoiding a failed global composition first.
- Scan candidate content boundaries locally at four frames per second in 640×360 grayscale. Stream one frame at a time through the existing media queue; no image collection, new dependency or model is added. Track each edge independently so a persistent toolbar border cannot mask a newly clipped title on another edge.
- For reused geometry, an edge alert requests fresh bounds. Fresh proposals detect new collisions after a clear edge and add the first event plus adjacent timestamps to the seven rendered proof frames (at most ten). Semantic review can distinguish essential content from incidental editing guides. This is evidence for review, not a pixel-based declaration that content is wrong.
- A rejected fresh temporal review skips the alternative template with identical source bounds. An editorial panel or reused candidate can request one normal proposal using the original three samples plus up to three suspect samples. A rejected normal proposal keeps the source and marks it for review; no recursive repair loop.
- A scan is limited to 120 seconds of source and 15 seconds of admitted local work. Queue waiting does not consume the timeout. Cancellation and insufficient decoded coverage reject verification. Longer shots conservatively retain the source with a review notice. Automatic clips are at most 125 seconds (the ceiling of the longest length setting), so a whole-clip shot can exceed the scan limit; such a shot keeps the source with a review notice.

## Validation on 2026-09-21

Used the previously authorized T3.GG recording in isolated application data on the same 8 GiB Apple Silicon machine. Original projects/settings were untouched. Timings below are single local trials, excluding transcription, source assessment and cloud work.

| Source interval | Local boundary scan | Observation |
| --- | --- | --- |
| 477.01–508.67s (31.66s) | 3.47–4.00s | Stable graph passed without an alert. |
| 664.31–680.31s (16s) | 1.50–1.77s | Alert near 672.06s, including on geometry accepted by the previous seven-frame review. |
| 680.51–691.91s (11.4s) | 1.62–1.80s | Reuse mode flags an existing collision; fresh mode detects a later edge change near 691.76s on the previously repaired geometry. |
| 664.16–710.97s (46.81s), scene scan | 4.19–4.22s | Split the graph-to-dashboard transition at 692.11–696.71s before composition. |

The first cloud repair experiment completed in 16.03s with one fresh proposal, but the local guard rejected it. Inspection showed a temporary vertical drawing guide extending beyond the graph axis. A hard veto on every new edge feature would produce avoidable full-frame fallbacks. This failed experiment motivated augmented rendered review for fresh proposals; it is not reported as a repair success.

The revised 664.31–680.31s run completed in 21.34s using the cached source proposal and one fresh ten-image review. It accepted a separate presenter and enlarged graph. Inspected rendered frames at 665s, 672.06s and 679s retain the labels, graph and presenter; the moved title approaches the upper boundary late in the interval. This is a targeted development-source check, not an independent quality result or a fully cold timing. The two trials used two fresh subscription requests in total and respected the existing daily cap.

Rendered that interval through the ordinary exporter with its original audio and captions: 1080×1920, 29.97 fps, 16.05 seconds, audio present, and full output decoding passed.

All 515 automated tests, type checking, lint and production build passed locally before release preparation. Read-only Bugbot review found no actionable issues, including after the false-alarm correction.

Automated tests use actual FFmpeg to create a brief crop collision between all seven uniform samples, alongside a static border on a different edge. They verify source-relative timing, incomplete coverage, cancellation, length limits, targeted proposal/review images, bounded repair, acceptance of a reviewed incidental guide, and that temporary retry timestamps never enter saved shot data. Scene-routing tests verify one upfront split and composition pass.

## Remaining work

1. Validate the alert precision and omission rate on independent creators and video types. A cursor, guide or animated border can trigger it; a low-contrast label or event shorter than 250ms can evade it. Only the first event is targeted, and a persistent collision present from the start is left to sampled semantic review for fresh proposals.
2. Track moving/resizing presenter panels, meaningful text and object boundaries. The new guard checks content edges only and retains fixed rectangles per shot. It does not certify every frame, legibility or editorial performance.
3. Bound repair latency and improve source-region suggestions using measured failures. AI can still accept bad crops or reject good ones. A fresh per-shot proposal does not yet receive an additional automatic region-repair round.
4. Benchmark complete workflows, peak RAM and UI responsiveness on low-memory Windows/Linux and macOS. Added scans cost seconds, and a rejected candidate can still add cloud calls; these measurements do not establish an overall speedup.
5. Continue the held-out quality corpus, explicit reanalysis/correction UI, durable jobs and category-specific layouts in the broader roadmap. Existing accepted compositions are not silently reanalysed by this increment.
