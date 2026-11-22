import { describe, expect, it } from 'vitest'
import { rendererSettingsUpdate } from '../src/main/settings'

describe('settings updates from the renderer', () => {
  it('may clear the music folder or resend the stored one', () => {
    expect(rendererSettingsUpdate({ musicFolder: null }, '/music')).toEqual({ musicFolder: null })
    expect(rendererSettingsUpdate({ musicFolder: '' }, '/music')).toEqual({ musicFolder: '' })
    expect(rendererSettingsUpdate({ musicFolder: '/music' }, '/music')).toEqual({ musicFolder: '/music' })
    expect(rendererSettingsUpdate({ quality: 'high' }, null)).toEqual({ quality: 'high' })
  })

  it('may not name a new music folder, which would open it to media://', () => {
    expect(() => rendererSettingsUpdate({ musicFolder: '/home/someone/.ssh' }, '/music')).toThrow(/folder picker/)
    expect(() => rendererSettingsUpdate({ musicFolder: '/etc' }, null)).toThrow(/folder picker/)
  })
})
