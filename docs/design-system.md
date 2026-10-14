# Cutawan's family design-system adapter

The [family specification](../design-system/README.md) defines shared foundations with Metachlorian and its website. Cutawan's role is creating and exporting edits; its timeline, transcript, framing and caption controls remain domain-specific.

## Implemented adoption

`src/renderer/src/index.css` imports the committed `design-system/foundations.css` after Tailwind. The family CSS uses only `--family-*` names, so it does not override existing `@theme` surface or accent values. Keyboard focus uses a visible neutral outline. Reduced motion suppresses UI control transitions while leaving authored caption/video animation untouched.

Existing renderer colours, the Cutawan icon, Inter/system UI fonts, bundled export/caption fonts, range controls and macOS vibrancy remain intact. The player stays opaque black. A family identity does not require a different Cutawan logo or a tinted video surround.

Generate and verify the export:

```sh
python3 design-system/build.py
python3 design-system/build.py --check
```

Run `npm run typecheck`, `npm run lint`, `npm test`, and the existing Xvfb smoke suite for application changes. CI also checks the committed token export. Review visible focus in import/setup, clips, editor, settings, dialogs, timeline and transcript; do not rely only on stylesheet inspection.

## Next implementation slices

1. Consolidate repeated button/field/segmented-choice markup into local components with focus, disabled, busy and invalid states. Keep existing actions and keyboard behaviour.
2. Map the existing Tailwind semantic roles to family foundations as controls are migrated. A token migration must preserve contrast on macOS translucent surfaces, as well as Windows/Linux opaque ones.
3. Introduce consistent timecode/duration treatment in the clip list, transcript, trim and timeline, without changing source or export timing.
4. Use the shared handoff summary when integrating Metachlorian packages: ranges, source availability, recorded rights, destination, explicit action and recovery. This document does not implement that API or claim the current editor supports every library package.

Metachlorian uses “shot” for source ranges; Cutawan uses “clip” for edited selections. Model scores are provisional editorial judgements, not guaranteed performance. Unknown rights and missing sources need explicit text and recovery.

The canonical token JSON lives in the Metachlorian repo. This repo vendors version 1.0.0 and its compiler. Update the source/export together; never fetch tokens at runtime or change caption typography as part of a UI-font migration.
