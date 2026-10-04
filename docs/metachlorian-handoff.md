# Importing Metachlorian packages

Metachlorian is a footage library that finds
shots, checks their rights and builds a rough cut. It hands that rough cut to
Cutawan as a **package**: a folder (or a `.zip` of it) with the media, a
word-timed transcript, the edit and a rights summary. Cutawan opens the
package as an ordinary project, so captions, reframing, auto zoom and export
all work as usual.

An agent can do the whole trip without anyone moving files: it asks
Metachlorian for a package, then runs `cutawan --import-package` on it, and
the rough cut opens in the editor.

The format itself is Metachlorian's contract
(`docs/integration/cutawan-contract.md` in the Metachlorian repository, with
the JSON Schema next to it). This page covers the Cutawan side.

## Importing by hand

- On the home screen, choose **Import Metachlorian package…** and pick the
  package's `manifest.json` or its `.zip`. On macOS you can also pick the
  package folder itself.
- Or drop the `.zip` or the `manifest.json` onto the drop zone.

The project opens straight away. Nothing is transcribed and no API is called:
the package already has the transcript.

## Importing from the command line (agents)

```bash
cutawan --import-package "/path/to/remote-work-01JA7Z3K8V5R2Q9W4M6T1X0B3C"
cutawan --import-package "/path/to/remote-work-01JA7Z3K8V5R2Q9W4M6T1X0B3C.zip"
cutawan --import-package=relative/path/to/package
```

- The path can be the package folder, its `manifest.json` or a `.zip`.
  Relative paths are resolved against the directory you run the command in.
- If Cutawan is not running, it starts, imports the package and opens the
  project in the editor.
- If Cutawan is already running, the new launch hands the path to the running
  app and exits within a second. The running app imports the package, comes to
  the front and opens the project.
- The process that does the import prints one JSON line to stdout when it is
  done: `{"project_id": "…"}` on success or `{"error": "…"}` on failure.
  When the app was already running, that line comes from the running app, not
  from the launch that handed the path over.
- From a source checkout, the same works with
  `npx electron . --import-package "<path>"` after `npm run build`.

Imported projects live with every other project in Cutawan's app-data folder
(`projects/<id>/`). The package is copied in (`source.mp4` and `broll/`), so
the original can be moved or deleted afterwards.

## What gets imported

| Package (`manifest.json`) | In Cutawan |
|---|---|
| `cutawan.project_name`, else `name` | Project name |
| `stringout.file` | The project video (`source.mp4`) |
| `stringout.transcript` (`cutawan.transcript/1`) | The project transcript, so captions and tighten cuts work offline |
| `cutawan.flow`: `whole-video` (the default) | One full-video edit, opened in the editor |
| `cutawan.flow`: `clips` | One clip per `stringout.map` entry, titled with the shot description and marked "From package" instead of a score |
| `cutawan.aspect`, `captions`, `auto_zoom` | The edit's aspect ratio, captions on/off, auto zoom |
| `cutawan.video_type`, `prompt` | Project video type and clip-finding prompt |
| `cutawan.inserts[]` (mode `a_roll_with_inserts`) | Video B-roll inserts, timed on the stringout, playing from the item's `media.in` |
| `items[].safe_crops["9:16"].track` | The starting speaker track, so the crop follows the subject without on-device analysis |
| `rights`, `package_id`, `generator.instance` | A rights banner in the editor and the clip grid |

Supported modes are `stringout` and `a_roll_with_inserts`. A mode this version
does not know opens the stringout instead, with a note. `broll_library`
packages (B-roll candidates with no project video) are not supported yet.

### Video B-roll inserts

Inserts behave like Cutawan's own image B-roll: they show in the editor's
B-roll list (as video, with their length), can be switched between full screen
and overlay, turned off or removed. The preview plays the insert muted in sync
with the edit, and the export cuts the same footage in, so the two match. The
A-roll's sound carries on underneath; the insert's own audio is not used.

Tighten cuts never removes a pause in the middle of a video insert, because
that would jump the insert's footage forward mid-shot. Pauses elsewhere are
removed as usual. Re-running **Caption whole video** keeps the inserts.

### Rights

Metachlorian checks rights when it builds the package. Cutawan does not
override that decision or hide it:

- A verdict other than `allowed` (`restricted`, `blocked`, `unknown`) still
  imports, and a warning banner with the reasons stays above the editor and
  the clip grid for as long as the project is open.
- Credit lines the footage requires, and the earliest licence expiry, are
  shown in the same banner whatever the verdict.
- The package's `RIGHTS.md` has the full detail.

## Checks before import

Nothing is written until the package passes these checks, and a failed check
says which field is wrong:

- `schema_version` must be format 1 (`1.y.z`). A newer minor version is fine;
  a different major version is refused with a request to update Cutawan.
- `kind` must be `metachlorian.package`, and the required fields must be
  there (`package_id`, `name`, `generator`, `items`, `rights` and so on).
- Every path the manifest names must be a relative path inside the package,
  must exist, and must still be inside the package after following symlinks.
  Absolute paths, `..` and backslashes are refused.
- Files with a recorded `sha256` or size must match it.
- The stringout must be a video Cutawan can read, and so must each insert's
  file. Every insert must name an item whose media shipped, start before it
  ends, and end within the video.
- A `.zip` is unpacked into a temporary folder first. Entries that would land
  outside it, encrypted entries, ZIP64 archives and entries that fail their
  CRC are refused.

The project is then assembled in a hidden folder and moved into place in one
step, so a failed import leaves nothing half-made behind.

If the package transcript is empty (Metachlorian had not transcribed the
footage yet) or in a format Cutawan cannot use, the project imports without
one and the banner says so. **Caption whole video** then transcribes it as for
any other video.

## Not supported yet

- `broll_library` packages, and Metachlorian as a live B-roll source
  (searching the library from Cutawan's B-roll step).
- `cutawan://import?url=…` links for remote Metachlorian instances.
- `cutawan.follow_speaker`: the import does not run on-device speaker
  tracking across the whole video. Use the package's subject track, or run
  **Caption whole video** with speaker tracking after importing.
- Music beds and other audio-only media in a package are ignored.
- Headless export (`--export`): exporting is still a click in the editor.

## Testing

- `tests/handoff.test.ts` covers the importer and validator against the
  fixture package in `tests/fixtures/metachlorian-package/` (valid, zip,
  traversal, symlink escape, missing file, wrong major version, checksum,
  inserts, blocked verdict).
- `scripts/test-handoff.ts` imports the fixture and renders it offline,
  checking frame by frame that the insert shows the right footage and that the
  A-roll audio continues underneath:
  `npx tsx --tsconfig tsconfig.node.json scripts/test-handoff.ts`
- `scripts/smoke-test.sh` ends by launching the app with
  `--import-package` on the fixture and capturing `package-import.png`.
