# Metachlorian and Cutawan design system

Version 1.0.0 · 4 October 2026

The family helps filmmakers find a useful moment, understand it, and turn it into an edit. Its visual thesis is **precise frames, expressive footage, quiet tools**. Metachlorian discovers and explains shots. Cutawan creates and exports edits. The website introduces that workflow.

This is an implemented foundation and an adoption specification, not a claim that every component in both applications has been migrated. The website consumes the generated foundation CSS today. The application proposals introduce the same foundation source and adapters while preserving their existing working surfaces.

## What makes this a system

A useful system reduces decisions without hiding the work. It needs semantic tokens, predictable component behaviour, content rules, real workflow examples, accessible states, and a process for changing them. A colour palette or a component catalogue alone is insufficient.

Three layers prevent the website's presentation needs from leaking into an editing workspace:

1. **Foundations:** approved identity, neutral and brand palettes, spacing, shape, motion, minimum targets, and status meanings. `tokens.json` uses DTCG-style `$type` / `$value` definitions. `build.py` produces framework-independent CSS without dependencies.
2. **Profiles:** marketing, library, and editor map those foundations to semantic roles. Fonts, density, native window chrome, and a functional selection colour can differ for a reason.
3. **Components and patterns:** accessible controls and footage workflows built in each repository's existing stack. Shared behaviour comes before shared implementation.

The canonical foundation source belongs in `JeremySNR/Metachlorian/design-system`. Each independent repo vendors the same version of `tokens.json` and `build.py`; generated CSS is committed so static hosting and existing application builds need no new installation step. Do not fetch tokens or fonts at runtime. Record the source version in changes and compare the token files when updating the family. A shared package is appropriate later if maintaining these copies becomes a recurring problem.

## Identity

The approved **Found frame** mark shows two footage frames, with selection corners identifying the useful shot. The full lockup is the approved image, including its wordmark. The header and footer use it instead of typesetting a replacement name beside a similar icon.

- `Metachlorian-site/dist/assets/metachlorian-logo.png`: unchanged approved master, 2172 × 724.
- `metachlorian-logo.svg`: self-contained SVG embedding that exact PNG with its original viewport. This is an exact SVG container, **not editable vector paths**. Enlarging it retains the PNG's resolution limit.
- `metachlorian-mark.svg`: the same embedded source with a viewport around the original mark. Use with an accessible product name in compact app chrome.
- `favicon.svg`: the same original mark centred in a square viewport. No redrawing or alternate corner geometry.

The PNG is embedded rather than linked, so SVG consumers need no second network request. `verify.py` compares its decoded bytes with the master. The source SHA-256 is `3e96712252f308a84198b706fb5d1ec0c7a0be90663c701a277ecbc872a1f61e`.

Keep the original aspect ratio, colours, wordmark, and relative symbol size. Allow at least half a symbol-height of clearspace around the visible lockup. Do not stretch, tint, outline, animate, or run filters over the approved artwork. Marketing uses a 250px visible lockup at desktop and 192–220px on small screens. The mark in app chrome is 28 × 18px; keep the product's accessible name even when its visible wordmark is hidden. In forced-colour environments, readable system-colour text can replace the image.

Cutawan retains its established name and icon. The family relationship comes from shared footage frames, neutral working surfaces, control states and handoff language; replacing Cutawan's logo is a separate identity decision. The Star Wars origin informs the relationship between the products, while the mark communicates their actual use.

## Colour and profiles

| Role | Marketing site | Metachlorian workspace | Cutawan workspace |
| --- | --- | --- | --- |
| Brand | Violet `#5140c6`, ink `#25253d` | Approved mark in chrome; neutral surfaces | Existing Cutawan identity; neutral surfaces |
| Main background | White; pale violet in narrative sections | Edge Code neutral light/dark ramp | Existing near-monochrome dark ramp |
| Around footage | Neutral paper or black | Neutral grey or black | Opaque black playback well, including macOS glass |
| Primary action | Violet with white text | Existing Key selection/action tokens | Existing warm-white accent tokens |
| Selection | Explicit selected state; no image tint | Existing external Key ring + semantic state | Explicit range/clip state; no image tint |
| Keyboard focus | Neutral 2px outline, 4px offset | Existing neutral high-contrast focus | Neutral high-contrast outline |
| Rights/success | Icon + words + green | Recorded rights state + evidence | Export/result state + explanation |

Brand identity and interaction semantics are different roles. This release does not silently replace Metachlorian's deliberately chosen magenta Key or Cutawan's warm-white controls. A future change to those functional accents must update their contrast tables, screenshots and selection behaviour together. Shared roles and familiar workflows are more valuable than forcing identical colours onto different tasks.

Violet is for brand identity and the website's main actions. Green means a recorded cleared/success state, amber requires attention, red signals a blocked/error state, and blue is informational. Always pair status with text and a shape or icon. A selected clip is not a success state. Unknown rights are never shown as cleared. Keep brand colour, status colour, and user-configured caption colours separate.

## Typography, density and shape

| Surface | Typeface and hierarchy | Density |
| --- | --- | --- |
| Marketing | Existing self-hosted Bricolage Grotesque for headings; DM Sans for prose | 16px+ body, 14px controls, generous section spacing |
| Metachlorian | Existing Instrument Sans Variable for UI; JetBrains Mono for timecodes and evidence | Existing compact / standard / comfortable modes |
| Cutawan | Existing Inter/system UI stack; explicit mono for time and technical data | Dense editor with readable setup, transcript and settings views |

Do not use caption fonts as UI fonts. Caption styling is user content and must continue to match exported video. Use tabular numerals and disabled number ligatures for durations, timecodes and numeric comparisons. Leave browser text sizing enabled; reflow at 200% zoom without clipped controls. Dense metadata may be 12px; essential labels, error messages and frequently used controls should be 14px where space permits. Verify the actual fonts instead of relying on font-size alone.

Use the 4px spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48 and 64. Controls have 4px corners, popovers 6px, dialogs 8px. Reserve rounded-full shapes for things that require them, such as switch tracks. Use lines and spacing to group information; avoid nesting decorative cards inside other cards. Website illustrations may be expressive, while its controls follow the family shape rules.

## Component contracts

| Component | Required states and behaviour | Ownership |
| --- | --- | --- |
| Button | Default, hover, pressed, focus, disabled, busy; visible action verb; stable width; one primary action per task | Site HTML; React Aria in library; existing React/Tailwind in editor |
| Field/search | Persistent label; hint; invalid with recovery; keyboard submit; preserve input on failure | Each repo, shared semantics |
| Choice/tab | Explicit selected/checked state; correct roles; arrow-key behaviour; no colour-only state | Reuse each repo's primitives |
| Dialog/menu | Accessible name; keyboard operation; Escape; focus containment/restoration; scrollable content | Native dialog on site; React Aria in library; editor follows same contract |
| Status | Icon or shape + concise words; explanation and remedy where useful; live announcement only when state changes | Semantic status adapters |
| Shot/clip frame | Correct aspect ratio; in/out or duration nearby; independent preview, selection and focus; recorded rights visible | Product-specific rendering |
| Progress | Real stage/progress; cancellable when supported; failure recovery; preserve completed work | Product-specific processing |

Pointer targets are at least 24px under the WCAG 2.2 minimum; aim for 44px on coarse pointers and 48px for marketing actions. Target spacing exceptions require deliberate verification. Text contrast is at least 4.5:1 for normal text; meaningful control boundaries and focus indicators at least 3:1. Logos are a separate identity asset, not a way to justify low-contrast controls.

Feedback uses 80ms, controls 120ms, panels 180ms, dialogs 240ms. Motion should explain a change or preserve spatial context. Respect reduced motion for UI transitions and autoplay. Do not disable the user's authored caption animation or alter video exports because the OS asks for reduced UI motion. Preview/content controls need their own explicit setting if reduced playback motion is supported.

## Patterns specific to these products

**Discover → inspect → select → hand off.** Metachlorian shows why each shot matched, signal provenance and confidence, recorded rights, and exact ranges. Human corrections remain distinguishable from model output. Cutawan receives the selected ranges and presents an editable result, with preview, trim, transcript and export. Avoid implying that a search score proves usability or that a proposed edit is guaranteed to perform well.

**The handoff summary is shared.** Use the same order: collection/project name; shot count and total duration; destination; availability of original media/proxies; recorded rights and unresolved restrictions; explicit action; result and recovery. Keep source in/out, frame rate, media path and rights verdict with every shot. An unavailable file needs a relink action, not an empty preview. A destination app that is absent needs a useful export alternative. Design-system consistency does not by itself implement the package/API contract.

**Language carries trust.** Use “shot” for a source range in Metachlorian, “clip” for a selected/edited item in Cutawan, “file” for source media and “export” for an output. Say “recorded as cleared”, “model estimate” or “measured” where relevant. Use sentence case in control labels. Error messages say what happened and what the user can do. Keep the demo labelled as illustrative and preserve accurate provider/rights limitations.

**Protect footage judgement.** No violet or magenta tint over thumbnails, no coloured surround in a playback well, and no decorative glow over the viewer. Display selection outside the media. Metachlorian's fixed/resizable rails and Cutawan's timeline are domain tools; do not redesign them into marketing layouts.

## Adoption and maintenance

| Repository | Implemented foundation | Next component work |
| --- | --- | --- |
| `Metachlorian-site` | Approved SVG lockup; original-source favicon; generated family CSS; semantic marketing adapter; common controls, focus, statuses and neutral demo; guides generated from shared header/footer | Replace remaining legacy literal styles incrementally; keep generator and static checks in sync |
| `Metachlorian` | Proposed family source/export; existing Edge Code token names mapped to shared spacing, shape and timings; approved mark in app chrome | Review real light/dark screenshots, then expand the handoff summary and component documentation |
| `cutawan` | Proposed shared foundation/export; visible keyboard focus and UI reduced-motion rules; existing palette, caption fonts and macOS chrome preserved | Consolidate repeated buttons/fields as components; validate settings, timeline and handoff against these contracts |

The library's existing `docs/design/system.md` remains the detailed component and workflow specification. This document defines the family layer; it does not replace the  existing API, keyboard, virtualisation or media-performance requirements. Cutawan's adoption note describes its Electron and Tailwind adapter.

Changes should include the user task being improved, token/component changes, affected profiles, accessibility evidence and screenshots when behaviour/layout changes. Adding a shared primitive requires at least two actual consumers; avoid a speculative component library. Version shared foundations using semantic versioning: fixes are patch, additive tokens/patterns minor, removals or role changes major. Deprecate names before removing them.

Run the token generator in each repo and `--check` in CI or review. Check search → inspect → select → handoff on the library; import → trim → captions → export on the editor; demo → guide → install on the site. Test keyboard focus, empty/error/processing states, reduced motion, small viewports, text enlargement and each supported theme. Include missing footage, unknown rights and unavailable destination cases. Evaluate a design change by task completion and clarity; do not invent user-study scores.

## Research and decisions

- [Primer Primitives](https://github.com/primer/primitives): inspected its published source documentation for separation of base/functional tokens, generated exports, accessible colour modes and overrides.
- [Adobe Spectrum Tokens](https://github.com/adobe/spectrum-tokens): inspected its published token documentation for a reusable token layer alongside components.
- [Metachlorian's existing design research](https://github.com/JeremySNR/Metachlorian/blob/HEAD/docs/design/research.md) and [Edge Code specification](https://github.com/JeremySNR/Metachlorian/blob/HEAD/docs/design/system.md): existing project evidence for neutral footage surfaces, familiar editing geometry and inspectable model output.
- Cutawan's renderer CSS, top bar and README: inspected the current palette, native window constraints, caption-font handling and clip-editing workflows.

These sources informed architecture and product fit. This session did not run a new usability study or independently reverify the claims in earlier research. Browser verification may be limited by the execution environment; report that separately from passing source and token checks.
