import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewAudio, type PreviewMix } from '../../src/renderer/src/lib/previewAudio'

/** A stand-in <audio>: metadata arrives only when the test says so. */
class FakeAudio {
  static made: FakeAudio[] = []
  src = ''
  loop = false
  preload = ''
  volume = 1
  currentTime = 0
  duration = 30
  readyState = 0
  paused = true
  listeners = new Set<() => void>()
  plays = 0
  constructor() { FakeAudio.made.push(this) }
  addEventListener(_type: string, fn: () => void): void { this.listeners.add(fn) }
  removeEventListener(_type: string, fn: () => void): void { this.listeners.delete(fn) }
  play(): Promise<void> { this.plays++; this.paused = false; return Promise.resolve() }
  pause(): void { this.paused = true }
  loadMetadata(): void { this.readyState = 1; for (const fn of [...this.listeners]) fn() }
}

/** Enough AudioContext for the effects to schedule. */
class FakeContext {
  static started = 0
  static stopped = 0
  state = 'running'
  currentTime = 0
  sampleRate = 8000
  destination = {}
  createBuffer(_c: number, length: number): { copyToChannel: () => void; length: number } { return { length, copyToChannel: () => undefined } }
  createGain(): { gain: { value: number }; connect: (n: unknown) => unknown } { return { gain: { value: 1 }, connect: (n) => n } }
  createBufferSource(): object {
    return {
      buffer: null,
      connect: (n: unknown) => n,
      start: () => { FakeContext.started++ },
      stop: () => { FakeContext.stopped++ }
    }
  }
  resume(): Promise<void> { return Promise.resolve() }
}

const music = (extra: Partial<PreviewMix> = {}): PreviewMix =>
  ({ cues: [], musicUrl: 'media://track.mp3', envelope: [], ...extra })

beforeEach(() => {
  FakeAudio.made = []
  FakeContext.started = FakeContext.stopped = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('preview music and effects', () => {
  it('does not start music when paused before its metadata arrived', () => {
    const player = new PreviewAudio(music())
    player.sync(0)
    player.stop()
    const element = FakeAudio.made[0]
    element.loadMetadata()
    expect(element.plays).toBe(0)
    expect(element.paused).toBe(true)
  })

  it('keeps one pending start however often it is resynced', () => {
    const player = new PreviewAudio(music())
    player.sync(0)
    player.sync(1)
    player.sync(2)
    const element = FakeAudio.made[0]
    expect(element.listeners.size).toBe(1)
    element.loadMetadata()
    expect(element.plays).toBe(1)
    expect(element.currentTime).toBe(2)
  })

  it('stops the music at once when it is turned off mid-play', () => {
    const player = new PreviewAudio(music())
    player.sync(0)
    const element = FakeAudio.made[0]
    element.loadMetadata()
    expect(element.paused).toBe(false)
    player.tick(3)
    player.update(music({ musicUrl: null }))
    expect(element.paused).toBe(true)
  })

  it('reschedules effects from the current time when the cues move mid-play', () => {
    const player = new PreviewAudio(music({ musicUrl: null, cues: [{ kind: 'pop', start: 5 }] }))
    player.sync(0)
    expect(FakeContext.started).toBe(1)
    player.tick(2)
    // A trim moves the pop earlier: the old one is stopped, the new one scheduled.
    player.update(music({ musicUrl: null, cues: [{ kind: 'pop', start: 4 }] }))
    expect(FakeContext.stopped).toBe(1)
    expect(FakeContext.started).toBe(2)
    // An unchanged mix (a new envelope only) leaves playback alone.
    player.update(music({ musicUrl: null, cues: [{ kind: 'pop', start: 4 }], envelope: [{ t: 0, gain: 1 }] }))
    expect(FakeContext.started).toBe(2)
    // And nothing restarts while paused.
    player.stop()
    player.update(music({ musicUrl: null, cues: [{ kind: 'pop', start: 3 }] }))
    expect(FakeContext.started).toBe(2)
  })
})
