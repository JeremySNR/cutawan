import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
// @ts-expect-error plain ESM helper, no declaration file
import { buildManifests, expectedInstallerScope, validateManifests } from '../scripts/print-winget-manifest.mjs'

const SHA = 'c0e801a93b2c26dbc529e16f0c6fcf25a560728132a5a05a444406488a5433b5'

const manifests = buildManifests({
  version: '0.7.0',
  installerUrl:
    'https://github.com/JeremySNR/cutawan/releases/download/v0.7.0/Cutawan-Setup-0.7.0.exe',
  installerSha256: SHA,
  releaseUrl: 'https://github.com/JeremySNR/cutawan/releases/tag/v0.7.0',
  publishedAt: '2026-09-02T06:20:17Z'
})

// package.json is the source of truth for where the installer puts the app, so
// the manifest's Scope has to be derived from it rather than assumed.
const expectedScope = expectedInstallerScope(pkg.build.nsis)

describe('buildManifests', () => {
  it('emits the winget-pkgs identifier and NSIS installer', () => {
    expect(manifests.versionYaml).toContain('PackageIdentifier: JeremySNR.Cutawan')
    expect(manifests.versionYaml).toContain('PackageVersion: 0.7.0')
    expect(manifests.installerYaml).toContain('InstallerType: nullsoft')
    expect(manifests.installerYaml).toContain('Cutawan-Setup-0.7.0.exe')
    expect(manifests.installerYaml).toContain(`InstallerSha256: ${SHA.toUpperCase()}`)
    expect(manifests.installerYaml).toContain('ReleaseDate: 2026-09-02')
  })

  it('fills locale metadata winget-pkgs requires', () => {
    expect(manifests.localeYaml).toContain('PackageName: Cutawan')
    expect(manifests.localeYaml).toContain('License: MIT')
    expect(manifests.localeYaml).toContain('Moniker: cutawan')
    expect(manifests.localeYaml).toContain(
      'https://github.com/JeremySNR/cutawan/releases/tag/v0.7.0'
    )
  })
})

describe('validateManifests', () => {
  const validate = (overrides = {}, scope = expectedScope) =>
    validateManifests({ ...manifests, ...overrides }, { expectedScope: scope })

  it('accepts the trio it generates', () => {
    expect(validate()).toEqual([])
  })

  it('keeps the declared scope in step with the packaging config', () => {
    // Scope: user is only right while electron-builder's NSIS target stays
    // per-user. Turning on perMachine in package.json without moving the
    // manifest fails here instead of at winget-pkgs.
    expect(manifests.installerYaml).toContain(`Scope: ${expectedScope}`)
  })

  it('rejects a scope that disagrees with the packaging config', () => {
    expect(validate({}, 'machine')).toEqual([
      expect.stringContaining("package.json's NSIS config implies machine")
    ])
  })

  it('rejects a sha256 that is not 64 hex characters', () => {
    expect(
      validate({ installerYaml: manifests.installerYaml.replace(SHA.toUpperCase(), 'abc123') })
    ).toEqual([expect.stringContaining('InstallerSha256 must be 64 hex characters')])
  })

  it('rejects a version that disagrees across the trio', () => {
    expect(
      validate({
        localeYaml: manifests.localeYaml.replace('PackageVersion: 0.7.0', 'PackageVersion: 0.7.1')
      })
    ).toEqual([expect.stringContaining('PackageVersion must match across the trio')])
  })

  it('rejects a locale field winget requires', () => {
    expect(
      validate({ localeYaml: manifests.localeYaml.replace(/^ShortDescription:.*$/m, '') })
    ).toEqual([expect.stringContaining('locale manifest is missing ShortDescription')])
  })

  it('rejects a locale field outside the schema length limits', () => {
    expect(
      validate({ localeYaml: manifests.localeYaml.replace('License: MIT', 'License: M') })
    ).toEqual([expect.stringContaining('License must be at least 3 characters')])
  })

  it('rejects an architecture winget does not accept', () => {
    expect(
      validate({ installerYaml: manifests.installerYaml.replace('Architecture: x64', 'Architecture: arm64e') })
    ).toEqual([expect.stringContaining('unsupported installer architecture: arm64e')])
  })

  it('rejects an installer URL that does not name the versioned asset', () => {
    expect(
      validate({
        installerYaml: manifests.installerYaml.replace('Cutawan-Setup-0.7.0.exe', 'Cutawan-Setup.exe')
      })
    ).toEqual([expect.stringContaining('InstallerUrl must name the 0.7.0 asset')])
  })

  it('rejects duplicated tags', () => {
    expect(
      validate({ localeYaml: manifests.localeYaml.replace('  - openai', '  - video') })
    ).toEqual([expect.stringContaining('Tags must be unique')])
  })

  it('rejects a package identifier with fewer than two parts', () => {
    expect(
      validate({
        versionYaml: manifests.versionYaml.replace(
          'PackageIdentifier: JeremySNR.Cutawan',
          'PackageIdentifier: Cutawan'
        )
      })
    ).toEqual([
      expect.stringContaining('PackageIdentifier is not a valid package identifier'),
      expect.stringContaining('PackageIdentifier must match across the trio')
    ])
  })

  it('rejects a package version with a character winget forbids', () => {
    expect(
      validate({
        versionYaml: manifests.versionYaml.replace('PackageVersion: 0.7.0', 'PackageVersion: 0.7/0')
      })
    ).toEqual([
      expect.stringContaining('PackageVersion is not a valid package version'),
      expect.stringContaining('PackageVersion must match across the trio')
    ])
  })

  it('rejects an installer URL that is not http(s)', () => {
    expect(
      validate({
        installerYaml: manifests.installerYaml.replace(
          '    InstallerUrl: https://github.com',
          '    InstallerUrl: ftp://github.com'
        )
      })
    ).toEqual([expect.stringContaining('InstallerUrl must be http(s)')])
  })
})
