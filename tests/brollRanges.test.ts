import { afterEach, describe, expect, it, vi } from 'vitest'
import { suggestBroll } from '../src/main/pipeline/broll'
import { chatJSON } from '../src/main/pipeline/openai'
import { generateSocialCaption } from '../src/main/pipeline/socialCaption'
import type { Clip } from '@shared/types'
import { makeTranscript } from './helpers'

vi.mock('../src/main/pipeline/openai', () => ({ chatJSON: vi.fn() }))
vi.mock('../src/main/projects', () => ({ projectDir: () => '/tmp' }))

afterEach(() => vi.resetAllMocks())

// Thirty sentences of 2.7 s; the clip plays sentences 0-3 and 20-23.
const transcript = makeTranscript(Array.from({ length: 30 }, (_, i) => `line${i} about topic${i} right here now.`))
const first = { start: transcript.segments[0].start, end: transcript.segments[3].end + 0.2 }
const second = { start: transcript.segments[20].start - 0.2, end: transcript.segments[23].end }
const clip: Clip = {
  id: 'c', suggestedStart: first.start, suggestedEnd: second.end, title: 'Joined', hook: '', summary: '',
  viralityScore: 50, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
  stitch: { segments: [first, second], reason: '' },
  edit: {
    aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: false, focusX: 0.5, captionsEnabled: true,
    captionStyleId: 'beast', showTitle: false, start: first.start, end: second.end, cuts: [{ start: first.end, end: second.start }]
  }
}

describe('a joined clip is described by what it plays', () => {
  it('offers the B-roll model only the played words and refuses inserts in the skipped stretch', async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      items: [
        { trigger: 'topic1', query: 'q', start: transcript.segments[1].start, duration: 3, mode: 'overlay' },
        { trigger: 'topic10', query: 'q', start: transcript.segments[10].start, duration: 3, mode: 'overlay' },
        // Starts a second before the first moment ends: it is held inside it.
        { trigger: 'topic3', query: 'q', start: first.end - 1, duration: 4, mode: 'overlay' },
        { trigger: 'topic21', query: 'q', start: transcript.segments[21].start, duration: 3, mode: 'fullscreen' }
      ]
    })
    const items = await suggestBroll('key', 'model', transcript, clip)
    const prompt = (vi.mocked(chatJSON).mock.calls[0][2][1].content as string)
    expect(prompt).toContain('topic2')
    expect(prompt).toContain('topic22')
    expect(prompt).not.toContain('topic10')
    expect(items.map((item) => item.trigger)).toEqual(['topic1', 'topic3', 'topic21'])
    for (const item of items) {
      const inside = [first, second].some((range) => item.start >= range.start && item.end <= range.end)
      expect(inside, item.trigger).toBe(true)
    }
  })

  it('writes the post caption from the played words only', async () => {
    vi.mocked(chatJSON).mockResolvedValue({ caption: 'A caption' })
    await generateSocialCaption('key', 'model', clip, transcript)
    const prompt = JSON.stringify(vi.mocked(chatJSON).mock.calls[0][2])
    expect(prompt).toContain('topic0')
    expect(prompt).toContain('topic23')
    expect(prompt).not.toContain('topic12')
  })
})
