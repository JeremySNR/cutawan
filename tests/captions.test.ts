import { describe, expect, it } from 'vitest'
import { buildAss } from '../src/main/pipeline/captions'
import { makeTranscript } from './helpers'
import { CAPTION_HOLD_SEC } from '@shared/captionLayout'

describe('buildAss', () => {
  const transcript = makeTranscript(['hello brave new world'], { wordSec: 0.5, gapSec: 0.1 })
  const base = {
    styleId: 'beast',
    width: 1080,
    height: 1920,
    clipStart: 0,
    clipEnd: transcript.durationSec
  }

  it('emits one karaoke event per word', () => {
    const ass = buildAss(transcript, base)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))
    expect(events.length).toBe(4)
  })

  it('pops the active word on its own layer so the other words never move', () => {
    const ass = buildAss(transcript, base)
    const baseLayer = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))
    const popLayer = ass.split('\n').filter((l) => l.startsWith('Dialogue: 2,'))
    expect(popLayer).toHaveLength(baseLayer.length)
    // Scaling a word re-flows a centred libass line, so the layer that draws
    // the other words never scales anything.
    for (const line of baseLayer) expect(line).not.toMatch(/\\fsc|\\t\(/)
    // Both layers carry the same words and anchor, so they share one layout.
    const strip = (l: string): string => l.slice(l.indexOf(',', 12)).replace(/\{[^}]*\}/g, '')
    baseLayer.forEach((line, i) => expect(strip(popLayer[i])).toBe(strip(line)))
    // Second word active: hidden in the base layer, the only visible word on top.
    expect(baseLayer[1]).toMatch(/\{\\c&H00D4FF&\\alpha&HFF&\}BRAVE/)
    expect(popLayer[1]).toContain('{\\alpha&HFF&}HELLO')
    expect(popLayer[1]).toMatch(/\\fscx94\\fscy94\\t\(0,90,0\.5,\\fscx100\\fscy100\)\}BRAVE/)
  })

  it('plays the pop once per word, not again at a layout boundary', () => {
    const ass = buildAss(transcript, { ...base, positionRanges: [{ start: 0.25, end: 0.4, positionY: 0.38 }] })
    const pops = ass.split('\n').filter((l) => l.startsWith('Dialogue: 2,'))
    // The first word is split in three by the band; only its first part pops.
    expect(pops[0]).toContain('\\t(')
    expect(pops[1]).not.toContain('\\t(')
    expect(pops[2]).not.toContain('\\t(')
  })

  it('splits a caption event at a layout boundary to keep preview and export positions aligned', () => {
    const ass = buildAss(transcript, { ...base, positionRanges: [{ start: .25, end: .4, positionY: .38 }] })
    const events = ass.split('\n').filter(l => l.startsWith('Dialogue: 0,'))
    expect(events).toHaveLength(6)
    expect(events[0]).toContain('0:00:00.00,0:00:00.25')
    expect(events[1]).toContain('0:00:00.25,0:00:00.40')
    expect(events[1]).toContain('\\pos(540,730)')
    expect(events[2]).toContain('\\pos(540,1382)')
  })

  it('centres every caption block on the style anchor line, matching the preview', () => {
    const ass = buildAss(transcript, base)
    // Beast anchors at 72% of the frame height; \\an5 centres the block there.
    expect(ass).toContain('{\\an5\\q2\\pos(540,1382)}')
    // Caption wrapping is ours (\\q2 per event); the script keeps smart
    // wrapping so the hook title, which has no explicit breaks, still wraps.
    expect(ass).toContain('WrapStyle: 0')
    expect(ass).toMatch(/Style: Caption,[^\n]*,1,3.2,1,5,54,54,0,1/)
  })

  it('breaks lines itself with \\N when a group needs two lines', () => {
    // Seven short words in the small "whisper" style on a 9:16 frame lay out
    // as two lines; the export must carry that break explicitly.
    const t = makeTranscript(['captions that run long enough to wrap around'], {
      wordSec: 0.3,
      gapSec: 0.05
    })
    const ass = buildAss(t, { ...base, styleId: 'whisper', clipEnd: t.durationSec })
    expect(ass).toContain('\\N')
  })

  it('holds the last word of a group on screen briefly, but never into the next group', () => {
    const t = makeTranscript(['first line.', 'second line.'], {
      wordSec: 0.5,
      gapSec: 0.1,
      sentenceGapSec: 4
    })
    const ass = buildAss(t, { ...base, clipEnd: t.durationSec })
    const events = ass
      .split('\n')
      .filter((l) => l.startsWith('Dialogue: 0,'))
      .map((l) => l.split(',').slice(1, 3))
    // Group one's last word is spoken 0.6-1.1s; its event runs on by the hold.
    expect(events[1]).toEqual(['0:00:00.60', '0:00:02.60'])
    expect(CAPTION_HOLD_SEC).toBe(1.5)
    // The next group's first word starts at 5.2s, well after the hold ended.
    expect(events[2][0]).toBe('0:00:05.20')
  })

  it('re-bases event times to the clip start', () => {
    const shifted = makeTranscript(['late words here'], { startSec: 60 })
    const ass = buildAss(shifted, { ...base, clipStart: 60, clipEnd: 63 })
    // No event may start at/after 60s — everything is clip-relative.
    expect(ass).not.toMatch(/Dialogue: \d,0:01:/)
    expect(ass).toContain('Dialogue: 0,0:00:00')
  })

  it('adds a title event when a title is provided', () => {
    const ass = buildAss(transcript, { ...base, title: 'The Hook' })
    expect(ass).toContain('Dialogue: 1,')
    expect(ass).toContain('The Hook')
  })

  it('leaves the hook title free to wrap inside its margins', () => {
    const ass = buildAss(transcript, { ...base, title: 'A long hook that must wrap onto two lines' })
    const title = ass.split('\n').find((l) => l.startsWith('Dialogue: 1,'))!
    expect(title).not.toContain('\\q2')
    expect(title).not.toContain('\\N')
  })

  it('escapes ASS control characters in words', () => {
    const t = makeTranscript(['plain'], {})
    t.segments[0].words[0].text = '{override\\}'
    const ass = buildAss(t, { ...base, clipEnd: t.durationSec })
    // Braces and backslashes are stripped (beast style also uppercases).
    expect(ass).not.toContain('{OVERRIDE')
    expect(ass).not.toContain('OVERRIDE\\')
    expect(ass).toContain('OVERRIDE')
  })

  it('converts style colours to ASS BGR form', () => {
    const ass = buildAss(transcript, base)
    // Beast style highlight #FFD400 -> &H00D4FF (BGR).
    expect(ass).toContain('&H00D4FF&')
  })

  it('uppercases words for uppercase styles', () => {
    const ass = buildAss(transcript, base)
    expect(ass).toContain('HELLO')
  })

  it('uses the style font by default and honours a custom font override', () => {
    expect(buildAss(transcript, base)).toContain('Style: Caption,Anton,')
    const ass = buildAss(transcript, { ...base, fontFamily: 'My Brand Font' })
    expect(ass).toContain('Style: Caption,My Brand Font,')
    expect(ass).toContain('Style: Title,My Brand Font,')
  })
})
