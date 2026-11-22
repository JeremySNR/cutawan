import { describe, expect, it } from 'vitest'
import { inferVideoType, videoTypeGuidance } from '../src/main/pipeline/videoTypePrompt'
import { transcriptSentences } from '@shared/sentences'
import type { SpeakerTurn, Transcript } from '@shared/types'
import { makeTranscript } from './helpers'

/** A transcript of `count` sentences made by cycling through `lines`. */
function build(lines: string[], count = 80, turns?: SpeakerTurn[]): { transcript: Transcript; sentences: ReturnType<typeof transcriptSentences> } {
  const transcript = makeTranscript(Array.from({ length: count }, (_, i) => lines[i % lines.length]))
  if (turns) transcript.speakerTurns = turns
  return { transcript, sentences: transcriptSentences(transcript) }
}

const plain = [
  'I spent ten years building companies before I understood this.',
  'Most people start with the product and never talk to customers.',
  'That was exactly my mistake the first time around.',
  'The second time I did the opposite and it worked.'
]

describe('inferVideoType', () => {
  it('reads a screen walkthrough from its vocabulary', () => {
    const { transcript, sentences } = build([
      'Now click the button in the sidebar.',
      'You can see the dashboard updates straight away.',
      'Open the settings menu and toggle this on.',
      'This feature saves our team hours every week.'
    ])
    expect(inferVideoType(transcript, sentences)).toBe('product-demo')
  })

  it('reads a presentation from its vocabulary', () => {
    const { transcript, sentences } = build([
      'On the next slide you will see the agenda for today.',
      'Please drop your questions in the chat as we go.',
      'Our research shows retention doubled last year.',
      'The webinar recording will be sent to all attendees.'
    ])
    expect(inferVideoType(transcript, sentences)).toBe('webinar')
  })

  it('reads a conversation from two voices with real shares of the speech', () => {
    const { transcript, sentences } = build(plain, 80, [
      { start: 0, end: 100, speaker: 0 },
      { start: 100, end: 160, speaker: 1 },
      { start: 160, end: 300, speaker: 0 }
    ])
    expect(inferVideoType(transcript, sentences)).toBe('podcast')
  })

  it('reads a monologue from one voice holding nearly all the speech', () => {
    const { transcript, sentences } = build(plain, 80, [
      { start: 0, end: 290, speaker: 0 },
      { start: 290, end: 300, speaker: 1 }
    ])
    expect(inferVideoType(transcript, sentences)).toBe('talking-head')
  })

  it('reads an interview from a high share of questions when no turns are known', () => {
    const { transcript, sentences } = build([...plain, 'So what did you learn from that?', 'Why do you think it worked?'])
    expect(inferVideoType(transcript, sentences)).toBe('podcast')
  })

  it('makes no guess without turns or clear cues, or from too little text', () => {
    const { transcript, sentences } = build(plain)
    expect(inferVideoType(transcript, sentences)).toBeNull()
    const short = build(['Click the button now.'], 10)
    expect(inferVideoType(short.transcript, short.sentences)).toBeNull()
  })

  it('lets demo vocabulary win over two voices: a demo can have a co-presenter', () => {
    const { transcript, sentences } = build([
      'Now click the button in the sidebar.',
      'You can see the dashboard updates straight away.'
    ], 80, [{ start: 0, end: 100, speaker: 0 }, { start: 100, end: 200, speaker: 1 }])
    expect(inferVideoType(transcript, sentences)).toBe('product-demo')
  })
})

describe('videoTypeGuidance', () => {
  it('gives the chosen format its paragraph', () => {
    expect(videoTypeGuidance('podcast', null)).toMatch(/^Format: this is a podcast or interview\. .*Never a host's question on its own/)
    expect(videoTypeGuidance('webinar', 'podcast')).toContain('housekeeping')
    expect(videoTypeGuidance('product-demo', null)).toContain('the feature that solves it')
    expect(videoTypeGuidance('talking-head', null)).toContain('one idea from its claim to where it lands')
  })

  it('offers an inferred format as a hint, and nothing when there is no guess', () => {
    expect(videoTypeGuidance('auto', 'webinar')).toMatch(/^Format: this looks like a webinar or presentation \(judged from the transcript/)
    expect(videoTypeGuidance('auto', null)).toBe('')
  })
})
