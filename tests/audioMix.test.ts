import { describe, expect, it } from 'vitest'
import {
  MAX_SFX_PER_CLIP,
  MIN_SFX_GAP_SEC,
  SFX_SPECS,
  SFX_TAIL_FREE_SEC,
  envelopeGain,
  isMusicFile,
  musicGainEnvelope,
  pickMusicTrack,
  planSoundEffects,
  sfxSample,
  speechSpans,
  whooshEnvelope
} from '@shared/audioMix'
import { clipSoundEffects } from '@shared/clipOverlays'
import { ClipTimeline } from '@shared/clipTimeline'
import type { Clip } from '@shared/types'

describe('placing sound effects', () => {
  it('whooshes at the cold-open seam and pops at the title', () => {
    const cues = planSoundEffects({ duration: 30, coldOpenSeam: 2.5, titleAt: 4.5 })
    expect(cues.map((c) => c.kind)).toEqual(['whoosh', 'pop'])
    // The whoosh swells into the seam.
    expect(cues[0].start).toBeCloseTo(2.5 - SFX_SPECS.whoosh.lead, 9)
    expect(cues[1].start).toBeCloseTo(4.5, 9)
  })

  it('keeps effects at least 1.5 s apart, earlier rules first', () => {
    const cues = planSoundEffects({ duration: 30, coldOpenSeam: 2.5, titleAt: 2.5, joins: [3.5, 10] })
    expect(cues.map((c) => c.kind)).toEqual(['whoosh', 'whoosh'])
    const events = cues.map((c) => c.start + SFX_SPECS[c.kind].lead)
    for (let i = 1; i < events.length; i++) expect(events[i] - events[i - 1]).toBeGreaterThanOrEqual(MIN_SFX_GAP_SEC)
  })

  it('never places more than three, nor any in the last 0.6 s', () => {
    const cues = planSoundEffects({ duration: 20, titleAt: 0, joins: [3, 6, 9, 12, 19.6] })
    expect(cues).toHaveLength(MAX_SFX_PER_CLIP)
    expect(cues.every((c) => c.start + SFX_SPECS[c.kind].lead <= 20 - SFX_TAIL_FREE_SEC)).toBe(true)
  })

  it('follows a clip: joins of separate moments, nothing when off', () => {
    const clip: Pick<Clip, 'id' | 'edit' | 'hook' | 'title' | 'emphasis'> = {
      id: 'c', hook: '', title: '',
      edit: {
        aspect: '9:16', reframeMode: 'crop', framing: 'manual', focusX: 0.5, captionsEnabled: true, captionStyleId: 'beast',
        showTitle: false, tightenCuts: false, start: 60, end: 372, cuts: [{ start: 70, end: 360 }], soundEffects: true
      }
    }
    const timeline = new ClipTimeline([{ start: 60, end: 70 }, { start: 360, end: 372 }])
    expect(clipSoundEffects(clip, timeline, null)).toEqual([{ kind: 'whoosh', start: 10 - SFX_SPECS.whoosh.lead }])
    expect(clipSoundEffects({ ...clip, edit: { ...clip.edit, soundEffects: false } }, timeline, null)).toEqual([])
  })

  it('synthesises bounded, decaying sounds', () => {
    for (const kind of ['pop', 'ding'] as const) {
      const peak = Math.max(...Array.from({ length: 2000 }, (_, i) => Math.abs(sfxSample(kind, i / 48000))))
      expect(peak).toBeLessThanOrEqual(1)
      expect(Math.abs(sfxSample(kind, SFX_SPECS[kind].duration))).toBeLessThan(0.05)
    }
    expect(whooshEnvelope(SFX_SPECS.whoosh.lead)).toBeCloseTo(1, 6)
    expect(whooshEnvelope(0)).toBe(0)
    expect(whooshEnvelope(SFX_SPECS.whoosh.duration)).toBeCloseTo(0, 6)
  })
})

describe('background music', () => {
  it('picks a stable track per clip, and honours a choice that still exists', () => {
    const tracks = ['b.mp3', 'a.m4a', 'notes.txt', 'c.wav']
    const pick = pickMusicTrack(tracks, 'clip-1')
    expect(['a.m4a', 'b.mp3', 'c.wav']).toContain(pick)
    expect(pickMusicTrack([...tracks].reverse(), 'clip-1')).toBe(pick)
    expect(pickMusicTrack(tracks, 'clip-1', 'c.wav')).toBe('c.wav')
    expect(pickMusicTrack(tracks, 'clip-1', 'gone.mp3')).toBe(pick)
    expect(pickMusicTrack(['notes.txt'], 'clip-1')).toBeNull()
    expect(isMusicFile('Song.FLAC')).toBe(true)
  })

  it('ducks under speech and fades at both ends', () => {
    const spans = speechSpans([{ start: 2, end: 2.4 }, { start: 2.6, end: 3 }, { start: 6, end: 7 }])
    expect(spans).toEqual([{ start: 2, end: 3 }, { start: 6, end: 7 }])
    const env = musicGainEnvelope(spans, 10)
    expect(envelopeGain(env, 0)).toBe(0)
    expect(envelopeGain(env, 1.5)).toBeCloseTo(1, 6)
    expect(envelopeGain(env, 2.5)).toBeLessThan(0.4)
    expect(envelopeGain(env, 4.5)).toBeCloseTo(1, 6)
    expect(envelopeGain(env, 6.5)).toBeLessThan(0.4)
    expect(envelopeGain(env, 10)).toBe(0)
  })
})
