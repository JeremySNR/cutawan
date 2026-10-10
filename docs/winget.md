# Publishing Cutawan to winget

Windows is where most Cutawan installs happen. A
[winget](https://learn.microsoft.com/en-us/windows/package-manager/) package
lets people run:

```
winget install JeremySNR.Cutawan
```

The app is **not code-signed yet**, which winget allows. Users will still see a
SmartScreen prompt on first launch.

## First publish (one-off)

The first listing is a pull request to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Generate the
three YAML files from the latest GitHub release:

```bash
node scripts/print-winget-manifest.mjs --out .tmp/winget
```

The generator checks its own output before writing anything: the fields each
file has to carry under the 1.6.0 manifest schemas, the identifier and version
agreeing across the three files, the installer URL naming the versioned asset
the release uploads, the hash being 64 hex characters, the architecture and
installer type being ones winget accepts, and the locale strings staying inside
the schema's length limits. It also refuses a manifest whose `Scope` disagrees
with electron-builder's NSIS config in `package.json` (per-user today), since
that is what decides where winget installs the app. Nothing is written if a
check fails, and the reasons are printed.

That covers the shape winget-pkgs validates on a pull request. It cannot cover
the parts of their pipeline that need Windows — the installer actually running
and uninstalling, and the manual review — so watch the checks on the PR itself
after submitting.

Then either:

- install [wingetcreate](https://github.com/microsoft/winget-create) and submit
  (`wingetcreate submit .tmp/winget`), or
- open a PR against `microsoft/winget-pkgs` under
  `manifests/j/JeremySNR/Cutawan/<version>/` with those three files.

Package identifier: **JeremySNR.Cutawan**.

## Later releases (automatic)

Once the package exists, set two repository secrets/variables:

| Name | Where | Value |
| --- | --- | --- |
| `WINGET_TOKEN` | Actions secret | A PAT with `public_repo` that can open PRs on a fork of `winget-pkgs` |
| `WINGET_PACKAGE_ID` | Actions variable | `JeremySNR.Cutawan` |

The [Release workflow](../.github/workflows/release.yml) then runs
`winget-releaser` after each GitHub Release so the manifest stays current.
Leave `WINGET_PACKAGE_ID` empty until the first package is accepted, otherwise
the job would try to update a package that does not exist yet.

The job pins `vedantmgoyal9/winget-releaser` to a commit instead of `@v2`.
That action is handed `WINGET_TOKEN`, and `v2` is a moving tag — it currently
resolves to a commit pushed after the v2 release, so a tag move would run
unreviewed code with the token. Bump the pin on purpose:

```bash
gh api repos/vedantmgoyal9/winget-releaser/commits/v2 -q .sha
```
