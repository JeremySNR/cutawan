import { describe, expect, it } from 'vitest'
import { importLicence, isReuseLicence } from '@shared/importLicence'

describe('import licence', () => {
  it('recognises Creative Commons and public-domain licences', () => {
    expect(isReuseLicence('Creative Commons Attribution license (reuse allowed)')).toBe(true)
    expect(isReuseLicence('CC BY-SA 4.0')).toBe(true)
    expect(isReuseLicence('CC0')).toBe(true)
    expect(isReuseLicence('Public Domain Mark')).toBe(true)
  })

  it('treats a missing or standard licence as not marked for reuse', () => {
    expect(isReuseLicence(null)).toBe(false)
    expect(isReuseLicence(undefined)).toBe(false)
    expect(isReuseLicence('')).toBe(false)
    expect(isReuseLicence('Standard YouTube License')).toBe(false)
    expect(isReuseLicence('All rights reserved')).toBe(false)
  })

  it('records what the source said', () => {
    expect(importLicence('https://example.com/v', '  ')).toEqual({ url: 'https://example.com/v', license: null, reusable: false })
    expect(importLicence('u', 'Creative Commons Attribution license (reuse allowed)').reusable).toBe(true)
  })
})
