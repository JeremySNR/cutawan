/**
 * Prints a winget-pkgs manifest trio (version + installer + locale) for the
 * latest (or a given) GitHub release. Used for the first submit to
 * microsoft/winget-pkgs; later versions are published by the Release
 * workflow once WINGET_TOKEN is set (see docs/winget.md).
 *
 * Usage:
 *   node scripts/print-winget-manifest.mjs            # latest release
 *   node scripts/print-winget-manifest.mjs 0.7.0      # specific version
 *
 * Writes YAML to stdout as three files separated by banners, or to a
 * directory if --out DIR is passed.
 *
 * The trio is checked against the winget 1.6.0 manifest schemas before it is
 * written, so a submission winget-pkgs would reject fails here instead.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
// Same loader as scripts/verify-release.mjs: js-yaml is already a dependency,
// and parsing the emitted text checks the bytes we actually submit rather than
// the values we intended to write.
const yaml = require('js-yaml')

const PACKAGE_ID = 'JeremySNR.Cutawan'
const OWNER = 'JeremySNR'
const REPO = 'cutawan'
const PUBLISHER = 'Jeremy Smith'
const PACKAGE_NAME = 'Cutawan'
const DEFAULT_LOCALE = 'en-US'
const MANIFEST_VERSION = '1.6.0'

// Values below come from the schemas the trio declares
// (ManifestVersion 1.6.0), so winget-pkgs validates submissions against them:
//   https://aka.ms/winget-manifest.version.1.6.0.schema.json
//   https://aka.ms/winget-manifest.installer.1.6.0.schema.json
//   https://aka.ms/winget-manifest.defaultlocale.1.6.0.schema.json
const ARCHITECTURES = ['x86', 'x64', 'arm', 'arm64', 'neutral']
const INSTALLER_TYPES = [
  'msix',
  'msi',
  'appx',
  'exe',
  'zip',
  'inno',
  'nullsoft',
  'wix',
  'burn',
  'pwa',
  'portable'
]
const SCOPES = ['user', 'machine']
const UPGRADE_BEHAVIORS = ['install', 'uninstallPrevious', 'deny']
// The identifier and version patterns are the only schema rules that exclude
// ASCII control characters, which eslint's no-control-regex rejects inside a
// regex literal. They are predicates instead, with the same rules: at least two
// dot-separated parts, 1-32 characters each, and none of the characters Windows
// forbids (the identifier also rejects whitespace, the version does not).
const WINDOWS_RESERVED = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']

const hasExcludedChar = (text, excluded, { whitespace = false } = {}) =>
  [...text].some((char) => {
    const code = char.codePointAt(0)
    return (
      excluded.has(char) ||
      (code >= 0x01 && code <= 0x1f) ||
      (whitespace && /\s/.test(char))
    )
  })

const isSchemaPackageIdentifier = (value) => {
  const parts = value.split('.')
  if (parts.length < 2 || parts.length > 8) return false
  const excluded = new Set([...WINDOWS_RESERVED, '.'])
  return parts.every(
    (part) =>
      part.length >= 1 && part.length <= 32 && !hasExcludedChar(part, excluded, { whitespace: true })
  )
}

const isSchemaPackageVersion = (value) =>
  value.length >= 1 &&
  value.length <= 128 &&
  !hasExcludedChar(value, new Set(WINDOWS_RESERVED))

const SHA256_RE = /^[A-Fa-f0-9]{64}$/
const URL_RE = /^https?:\/\/.+/i
const LOCALE_RE = /^([a-zA-Z]{2,3}|[iI]-[a-zA-Z]+|[xX]-[a-zA-Z]{1,8})(-[a-zA-Z]{1,8})*$/

const REQUIRED = {
  version: [
    'PackageIdentifier',
    'PackageVersion',
    'DefaultLocale',
    'ManifestType',
    'ManifestVersion'
  ],
  installer: ['PackageIdentifier', 'PackageVersion', 'Installers', 'ManifestType', 'ManifestVersion'],
  locale: [
    'PackageIdentifier',
    'PackageVersion',
    'PackageLocale',
    'Publisher',
    'PackageName',
    'License',
    'ShortDescription',
    'ManifestType',
    'ManifestVersion'
  ]
}

const MANIFEST_TYPES = { version: 'version', installer: 'installer', locale: 'defaultLocale' }

// Bounds from the defaultLocale schema. The minima matter as much as the
// maxima: a two-character licence fails the schema's minLength.
const BOUNDED_LOCALE_FIELDS = {
  Publisher: [2, 256],
  PackageName: [2, 256],
  License: [3, 512],
  ShortDescription: [3, 256],
  Description: [3, 10000],
  Copyright: [3, 512]
}

const args = process.argv.slice(2)
let versionArg = null
let outDir = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outDir = args[++i]
    continue
  }
  if (!args[i].startsWith('-')) versionArg = args[i]
}

function sha256Of(asset) {
  const digest = asset.digest
  if (typeof digest === 'string' && digest.startsWith('sha256:')) return digest.slice(7)
  throw new Error(`Release asset ${asset.name} has no sha256 digest`)
}

/**
 * The scope the installer manifest must declare for the current packaging
 * config. electron-builder's NSIS target installs per machine only when
 * `perMachine` is true; `oneClick` does not change that. package.json leaves it
 * unset, so Cutawan's installer is per user, and `Scope: user` below has to
 * move with it if that ever changes.
 */
export function expectedInstallerScope(nsis = {}) {
  return nsis && nsis.perMachine === true ? 'machine' : 'user'
}

/**
 * Checks an emitted trio against the winget 1.6.0 schemas and the invariants
 * only this repo can know (the installer scope must match package.json, and
 * the installer URL must name the versioned asset the release builds).
 *
 * Returns a list of problems; an empty list means the trio is safe to submit.
 */
export function validateManifests(manifests, { expectedScope } = {}) {
  const problems = []
  const parsed = {}

  const kinds = Object.keys(REQUIRED)
  const keys = { version: 'versionYaml', installer: 'installerYaml', locale: 'localeYaml' }
  for (const kind of kinds) {
    try {
      parsed[kind] = yaml.load(manifests[keys[kind]])
    } catch (err) {
      problems.push(`${kind} manifest is not valid YAML: ${err.message}`)
    }
  }

  const objectOf = (kind) => {
    const data = parsed[kind]
    if (data === undefined || data === null) return null
    if (typeof data !== 'object' || Array.isArray(data)) {
      problems.push(`${kind} manifest is not a mapping`)
      return null
    }
    return data
  }

  const checkString = (kind, data, field, { matches, invalid, min, max, values } = {}) => {
    const value = data[field]
    if (value === undefined || value === null) return
    if (typeof value !== 'string') {
      problems.push(`${kind} manifest ${field} must be a string`)
      return
    }
    if (matches && !matches(value)) {
      problems.push(
        `${kind} manifest ${field} ${invalid ?? 'does not match the schema pattern'}: ${value}`
      )
    }
    if (min !== undefined && value.length < min) {
      problems.push(`${kind} manifest ${field} must be at least ${min} characters`)
    }
    if (max !== undefined && value.length > max) {
      problems.push(`${kind} manifest ${field} must be at most ${max} characters`)
    }
    if (values && !values.includes(value)) {
      problems.push(`${kind} manifest ${field} must be one of ${values.join(', ')}: ${value}`)
    }
  }

  for (const kind of kinds) {
    const data = objectOf(kind)
    if (!data) continue

    for (const field of REQUIRED[kind]) {
      if (data[field] === undefined || data[field] === '') {
        problems.push(`${kind} manifest is missing ${field}`)
      }
    }
    if (data.ManifestType !== undefined && data.ManifestType !== MANIFEST_TYPES[kind]) {
      problems.push(`${kind} manifest ManifestType must be ${MANIFEST_TYPES[kind]}`)
    }
    if (data.ManifestVersion !== undefined && data.ManifestVersion !== MANIFEST_VERSION) {
      problems.push(
        `${kind} manifest ManifestVersion must be ${MANIFEST_VERSION}: ${data.ManifestVersion}`
      )
    }
    checkString(kind, data, 'PackageIdentifier', {
      matches: isSchemaPackageIdentifier,
      invalid: 'is not a valid package identifier',
      max: 128
    })
    checkString(kind, data, 'PackageVersion', {
      matches: isSchemaPackageVersion,
      invalid: 'is not a valid package version',
      max: 128
    })
  }

  const version = parsed.version
  const installer = parsed.installer
  const locale = parsed.locale

  // Every file has to describe the same package at the same version, or
  // winget-pkgs rejects the trio even when each file is individually valid.
  const identifiers = [version, installer, locale]
    .map((data) => data?.PackageIdentifier)
    .filter((id) => id !== undefined)
  if (identifiers.length && new Set(identifiers).size !== 1) {
    problems.push(`PackageIdentifier must match across the trio: ${identifiers.join(', ')}`)
  }
  const versions = [version, installer, locale]
    .map((data) => data?.PackageVersion)
    .filter((v) => v !== undefined)
  if (versions.length && new Set(versions).size !== 1) {
    problems.push(`PackageVersion must match across the trio: ${versions.join(', ')}`)
  }

  if (version && locale && locale.PackageLocale !== undefined) {
    checkString('locale', locale, 'PackageLocale', {
      matches: (value) => LOCALE_RE.test(value),
      max: 20
    })
    if (version.DefaultLocale !== undefined && locale.PackageLocale !== version.DefaultLocale) {
      problems.push(
        `PackageLocale (${locale.PackageLocale}) must match DefaultLocale (${version.DefaultLocale})`
      )
    }
  }

  if (installer) {
    checkString('installer', installer, 'InstallerType', { values: INSTALLER_TYPES })
    checkString('installer', installer, 'Scope', { values: SCOPES })
    checkString('installer', installer, 'UpgradeBehavior', { values: UPGRADE_BEHAVIORS })
    if (installer.InstallerLocale !== undefined) {
      checkString('installer', installer, 'InstallerLocale', {
        matches: (value) => LOCALE_RE.test(value),
        max: 20
      })
      if (version?.DefaultLocale !== undefined && installer.InstallerLocale !== version.DefaultLocale) {
        problems.push(
          `InstallerLocale (${installer.InstallerLocale}) must match DefaultLocale (${version.DefaultLocale})`
        )
      }
    }
    // The declared scope decides where winget installs, so a mismatch would
    // hand users a per-machine install described as per-user (or the reverse).
    if (expectedScope && installer.Scope !== undefined && installer.Scope !== expectedScope) {
      problems.push(
        `installer manifest Scope is ${installer.Scope} but package.json's NSIS config implies ` +
          `${expectedScope}; change both together`
      )
    }

    if (!Array.isArray(installer.Installers)) {
      if (installer.Installers !== undefined) {
        problems.push('installer manifest Installers must be a list')
      }
    } else if (installer.Installers.length === 0) {
      problems.push('installer manifest needs at least one entry in Installers')
    } else if (installer.Installers.length > 1024) {
      problems.push('installer manifest has more than 1024 entries in Installers')
    } else {
      const seen = new Set()
      for (const entry of installer.Installers) {
        if (!entry || typeof entry !== 'object') {
          problems.push('every installers entry must be a mapping')
          continue
        }
        const label = entry.Architecture ?? 'unknown architecture'
        for (const field of ['Architecture', 'InstallerUrl', 'InstallerSha256']) {
          if (entry[field] === undefined || entry[field] === '') {
            problems.push(`installers entry (${label}) is missing ${field}`)
          }
        }
        if (entry.Architecture !== undefined && !ARCHITECTURES.includes(entry.Architecture)) {
          problems.push(`unsupported installer architecture: ${entry.Architecture}`)
        }
        if (typeof entry.InstallerSha256 === 'string' && !SHA256_RE.test(entry.InstallerSha256)) {
          problems.push(`InstallerSha256 must be 64 hex characters: ${entry.InstallerSha256}`)
        }
        if (typeof entry.InstallerUrl === 'string') {
          if (!URL_RE.test(entry.InstallerUrl)) {
            problems.push(`InstallerUrl must be http(s): ${entry.InstallerUrl}`)
          } else if (entry.InstallerUrl.length > 2048) {
            problems.push('InstallerUrl must be at most 2048 characters')
          }
          const asset = entry.InstallerUrl.split('/').pop()
          // A renamed artifact is the likeliest way this breaks silently: the
          // manifest would point at a file the release never uploads.
          if (installer.PackageVersion !== undefined && !asset.includes(installer.PackageVersion)) {
            problems.push(`InstallerUrl must name the ${installer.PackageVersion} asset: ${asset}`)
          }
          if (seen.has(entry.InstallerUrl)) {
            problems.push(`duplicate InstallerUrl: ${entry.InstallerUrl}`)
          }
          seen.add(entry.InstallerUrl)
        }
      }
    }
  }

  if (locale) {
    for (const [field, [min, max]] of Object.entries(BOUNDED_LOCALE_FIELDS)) {
      checkString('locale', locale, field, { min, max })
    }
    checkString('locale', locale, 'Moniker', { min: 1, max: 40 })
    for (const field of Object.keys(locale)) {
      if (/Url$/.test(field)) {
        checkString('locale', locale, field, { matches: (value) => URL_RE.test(value), max: 2048 })
      }
    }
    if (locale.Tags !== undefined) {
      if (!Array.isArray(locale.Tags)) {
        problems.push('locale manifest Tags must be a list')
      } else {
        if (locale.Tags.length > 16) problems.push('locale manifest allows at most 16 Tags')
        if (new Set(locale.Tags).size !== locale.Tags.length) {
          problems.push('locale manifest Tags must be unique')
        }
        if (locale.Tags.some((tag) => typeof tag !== 'string' || tag.length < 1 || tag.length > 40)) {
          problems.push('every locale manifest tag must be 1-40 characters')
        }
      }
    }
  }

  return problems
}

export function buildManifests({ version, installerUrl, installerSha256, releaseUrl, publishedAt }) {
  const date = (publishedAt ?? new Date().toISOString()).slice(0, 10)
  const versionYaml = `PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
DefaultLocale: ${DEFAULT_LOCALE}
ManifestType: version
ManifestVersion: ${MANIFEST_VERSION}
`

  const installerYaml = `PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
InstallerLocale: ${DEFAULT_LOCALE}
InstallerType: nullsoft
Scope: user
UpgradeBehavior: install
ReleaseDate: ${date}
Installers:
  - Architecture: x64
    InstallerUrl: ${installerUrl}
    InstallerSha256: ${installerSha256.toUpperCase()}
ManifestType: installer
ManifestVersion: ${MANIFEST_VERSION}
`

  const localeYaml = `PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
PackageLocale: ${DEFAULT_LOCALE}
Publisher: ${PUBLISHER}
PublisherUrl: https://github.com/${OWNER}
PublisherSupportUrl: https://github.com/${OWNER}/${REPO}/issues
Author: ${PUBLISHER}
PackageName: ${PACKAGE_NAME}
PackageUrl: https://github.com/${OWNER}/${REPO}
License: MIT
LicenseUrl: https://github.com/${OWNER}/${REPO}/blob/main/LICENSE
Copyright: Copyright (c) Cutawan Contributors
ShortDescription: Open-source Opus Clip alternative. Turn long videos into vertical clips on your desktop.
Description: Turn podcasts, webinars, streams and interviews into ready-to-post vertical clips. AI-picked moments, virality scores, animated captions, auto zoom and speaker-aware reframing. Runs on your machine; you bring an OpenAI API key.
Moniker: cutawan
Tags:
  - video
  - captions
  - clips
  - electron
  - openai
ReleaseNotesUrl: ${releaseUrl}
ManifestType: defaultLocale
ManifestVersion: ${MANIFEST_VERSION}
`

  return { versionYaml, installerYaml, localeYaml }
}

async function githubJson(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cutawan-winget' }
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`
  }
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, { headers })
  if (!res.ok) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const release = versionArg
    ? await githubJson(`releases/tags/v${versionArg.replace(/^v/, '')}`)
    : await githubJson('releases/latest')
  const version = String(release.tag_name ?? '').replace(/^v/, '')
  const installer = (release.assets ?? []).find((a) => /^Cutawan-Setup-.*\.exe$/.test(a.name))
  if (!installer) {
    throw new Error(`No Cutawan-Setup-*.exe on ${release.tag_name}`)
  }
  const manifests = buildManifests({
    version,
    installerUrl: installer.browser_download_url,
    installerSha256: sha256Of(installer),
    releaseUrl: release.html_url,
    publishedAt: release.published_at
  })

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const problems = validateManifests(manifests, {
    expectedScope: expectedInstallerScope(pkg.build?.nsis)
  })
  if (problems.length) {
    throw new Error(
      `This manifest would be rejected by winget-pkgs:\n  - ${problems.join('\n  - ')}`
    )
  }

  const files = [
    [`${PACKAGE_ID}.yaml`, manifests.versionYaml],
    [`${PACKAGE_ID}.installer.yaml`, manifests.installerYaml],
    [`${PACKAGE_ID}.locale.en-US.yaml`, manifests.localeYaml]
  ]

  if (outDir) {
    await mkdir(outDir, { recursive: true })
    for (const [name, body] of files) {
      await writeFile(join(outDir, name), body, 'utf8')
    }
    console.error(`Wrote ${files.length} files to ${outDir}`)
    return
  }

  for (const [name, body] of files) {
    process.stdout.write(`# --- ${name} ---\n${body}\n`)
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('print-winget-manifest.mjs')
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
