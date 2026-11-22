import type { ImportLicence } from './types'

/**
 * Reuse licences on URL imports. yt-dlp reports the licence a site shows
 * for a video (YouTube: "Creative Commons Attribution license (reuse
 * allowed)"; nothing for the standard licence). Cutawan only warns: whether
 * someone may clip a video depends on far more than this field (their own
 * channel, permission, fair dealing), so it never blocks an import.
 */

/** Licences that explicitly allow reuse: Creative Commons and public domain. */
const REUSE_PATTERN = /creative\s*commons|\bcc[\s-]?(by|0|zero)\b|public\s*domain|reuse allowed/i

export function isReuseLicence(license: string | null | undefined): boolean {
  return typeof license === 'string' && REUSE_PATTERN.test(license)
}

export function importLicence(url: string, license: string | null | undefined): ImportLicence {
  const value = typeof license === 'string' && license.trim() ? license.trim() : null
  return { url, license: value, reusable: isReuseLicence(value) }
}

export const LICENCE_WARNING = "This video isn't marked for reuse. Make sure you have the rights to clip it."
