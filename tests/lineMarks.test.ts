import { describe, expect, it } from 'vitest'
import {
  NO_MARKS,
  TOPIC_CHANGE_LINE,
  lineReactions,
  lineSpeakers,
  speakerLetters,
  transcriptMarks,
  type LineMarks
} from '../src/main/pipeline/lineMarks'
import {
  endingMarksGuidance,
  formatTranscriptForModel,
  joinFacts,
  joinMarksGuidance,
  markingsGuidance,
  playedText
} from '../src/main/pipeline/highlights'
import { transcriptSentences } from '@shared/sentences'
import type { Clip, SpeakerTurn } from '@shared/types'
import { makeTranscript } from './helpers'

// Six sentences of four words, each 1.5 s of speech 0.4 s apart: sentence k
// starts at 1.9k and ends at 1.9k + 1.5.
const transcript = makeTranscript(
  ['So what happened next?', 'We lost everything that day.', 'That must have hurt.', 'It really did hurt.', 'And then we rebuilt.', 'Best decision we made.'],
  { wordSec: 0.3, gapSec: 0.1, sentenceGapSec: 0.4 }
)
const sentences = transcriptSentences(transcript)
const at = (k: number) => sentences[k]
/** Enough later speech from the second voice that the video counts as a conversation. */
const laterB: SpeakerTurn = { start: 100, end: 120, speaker: 1 }

describe('speakerLetters', () => {
  it('letters speakers by first appearance, not by id', () => {
    const turns: SpeakerTurn[] = [{ start: 10, end: 30, speaker: 3 }, { start: 0, end: 10, speaker: 1 }]
    expect([...speakerLetters(turns)]).toEqual([[1, 'A'], [3, 'B']])
  })

  it('finds no conversation when only one voice has real speech', () => {
    expect(speakerLetters([{ start: 0, end: 60, speaker: 0 }, { start: 60, end: 62, speaker: 1 }]).size).toBe(0)
    expect(speakerLetters(undefined).size).toBe(0)
    expect(speakerLetters([]).size).toBe(0)
  })
})

describe('lineSpeakers', () => {
  it('labels each line by the voice of its words, and a line where the turn changes as mixed', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: at(1).start - 0.2, speaker: 0 },
      // Speaker 1 takes over for line 1 and the first half of line 2.
      { start: at(1).start - 0.2, end: at(2).start + 0.7, speaker: 1 },
      { start: at(2).start + 0.7, end: 30, speaker: 0 },
      laterB
    ]
    const labels = lineSpeakers(sentences, turns)
    expect(labels.get(0)).toBe('A')
    expect(labels.get(1)).toBe('B')
    expect(labels.get(2)).toBe('B, then A')
    expect(labels.get(3)).toBe('A')
  })

  it('does not call a line mixed for one stray word across a turn boundary', () => {
    const turns: SpeakerTurn[] = [
      { start: 0, end: at(1).start + 0.2, speaker: 0 },
      { start: at(1).start + 0.2, end: 30, speaker: 1 },
      { start: 100, end: 120, speaker: 0 }
    ]
    // Line 1's first word falls in speaker 0's turn, its other three in speaker 1's.
    expect(lineSpeakers(sentences, turns).get(1)).toBe('B')
  })

  it('labels nothing for a monologue or a line outside every turn', () => {
    expect(lineSpeakers(sentences, [{ start: 0, end: 30, speaker: 0 }]).size).toBe(0)
    const labels = lineSpeakers(sentences, [{ start: 0, end: at(1).end, speaker: 0 }, { start: at(4).start, end: 60, speaker: 1 }, { start: 60, end: 70, speaker: 0 }])
    expect(labels.has(2)).toBe(false)
    expect(labels.get(4)).toBe('B')
  })
})

describe('lineReactions', () => {
  it('marks the line a reaction follows, within the lag', () => {
    const marks = lineReactions(sentences, [
      { start: at(1).end + 0.3, end: at(1).end + 3, strength: 0.9, kind: 'laughter' },
      { start: at(3).end + 0.2, end: at(3).end + 2, strength: 0.7, kind: 'applause' },
      { start: at(4).end + 0.1, end: at(4).end + 1, strength: 0.6 }
    ])
    expect([...marks]).toEqual([[1, 'laughter'], [3, 'applause'], [4, 'reaction']])
  })

  it('marks the line a reaction starts during', () => {
    expect(lineReactions(sentences, [{ start: at(2).start + 0.5, end: at(2).end + 1, strength: 0.8, kind: 'laughter' }]).get(2)).toBe('laughter')
  })

  it('ignores quiet reactions, music, reactions long after a line and before the first', () => {
    const marks = lineReactions(sentences, [
      { start: at(1).end + 0.3, end: at(1).end + 3, strength: 0.1, kind: 'laughter' },
      { start: at(2).end + 0.3, end: at(2).end + 3, strength: 0.9, kind: 'music' },
      { start: at(5).end + 4, end: at(5).end + 6, strength: 0.9, kind: 'applause' },
      { start: 0, end: 0.1, strength: 0.9, kind: 'applause' }
    ])
    expect(marks.size).toBe(0)
  })

  it('prefers a named reaction to an unnamed one on the same line', () => {
    const marks = lineReactions(sentences, [
      { start: at(1).end + 0.1, end: at(1).end + 0.2, strength: 0.9 },
      { start: at(1).end + 0.3, end: at(1).end + 2, strength: 0.9, kind: 'laughter' }
    ])
    expect(marks.get(1)).toBe('laughter')
  })
})

describe('formatTranscriptForModel with marks', () => {
  const marks: LineMarks = {
    speakers: new Map([[0, 'A'], [1, 'B'], [2, 'B, then A']]),
    reactions: new Map([[1, 'laughter']]),
    topicStarts: new Set([0, 3])
  }

  it('adds the speaker after the times and the reaction after the text, keeping the line prefix', () => {
    const lines = formatTranscriptForModel(sentences, { marks }).split('\n')
    const times = (k: number) => `[${at(k).start.toFixed(1)}s - ${at(k).end.toFixed(1)}s]`
    expect(lines[0]).toBe(`#0 ${times(0)} (Speaker A) So what happened next?`)
    expect(lines[1]).toBe(`#1 ${times(1)} (Speaker B) We lost everything that day. [laughter after]`)
    expect(lines[2]).toBe(`#2 ${times(2)} (Speaker B, then A) That must have hurt.`)
    const numbered = lines.filter((l) => /^#\d+ \[\d+\.\ds - \d+\.\ds\] /.test(l))
    expect(numbered).toHaveLength(sentences.length)
  })

  it('puts a separator before a line that opens a topic, but not above the first line shown', () => {
    const lines = formatTranscriptForModel(sentences, { marks }).split('\n')
    expect(lines[3]).toBe(TOPIC_CHANGE_LINE)
    expect(lines[4]).toMatch(/^#3 /)
    expect(lines.filter((l) => l === TOPIC_CHANGE_LINE)).toHaveLength(1)
    expect(formatTranscriptForModel(sentences.slice(3), { marks }).split('\n')[0]).toMatch(/^#3 /)
  })

  it('keeps the delivery tag and the duration with marks', () => {
    const t = makeTranscript(['Loud one here.', 'Next one here.'])
    t.segments[0].energy = 0.95
    const line = formatTranscriptForModel(transcriptSentences(t), {
      durations: true,
      marks: { speakers: new Map([[0, 'A']]), reactions: new Map([[0, 'applause']]), topicStarts: new Set() }
    }).split('\n')[0]
    expect(line).toBe('#0 [0.0s - 1.1s, 1.1s long] (Speaker A) Loud one here. [delivery: energetic] [applause after]')
  })

  it('writes exactly the old lines without marks', () => {
    expect(formatTranscriptForModel(sentences, { marks: NO_MARKS })).toBe(formatTranscriptForModel(sentences))
    expect(formatTranscriptForModel(sentences)).not.toMatch(/Speaker|after\]|topic change/)
  })
})

describe('transcriptMarks', () => {
  it('builds nothing from a transcript without speakers, reactions or topics', () => {
    const marks = transcriptMarks(transcript, sentences)
    expect(marks.speakers.size + marks.reactions.size + marks.topicStarts.size).toBe(0)
    expect(markingsGuidance(marks)).toBe('')
    expect(endingMarksGuidance(marks)).toBe('')
    expect(joinMarksGuidance(marks)).toBe('')
  })

  it('explains only the marks the transcript has', () => {
    const speakersOnly: LineMarks = { ...NO_MARKS, speakers: new Map([[0, 'A']]) }
    expect(markingsGuidance(speakersOnly)).toContain('(Speaker A)')
    expect(markingsGuidance(speakersOnly)).not.toContain('[laughter after]')
    expect(markingsGuidance(speakersOnly)).not.toContain(TOPIC_CHANGE_LINE)
    const all: LineMarks = { speakers: new Map([[0, 'A']]), reactions: new Map([[1, 'laughter']]), topicStarts: new Set([3]) }
    const prompt = markingsGuidance(all)
    expect(prompt).toContain('The reaction comes AFTER the payoff')
    expect(prompt).toContain('Never open a clip on the line right after a reaction')
    expect(prompt).toContain(TOPIC_CHANGE_LINE)
    expect(joinMarksGuidance(all)).toContain('crossing a topic change')
    expect(endingMarksGuidance(all)).toContain('Never move an ending past it')
  })
})

describe('joinFacts', () => {
  const marks: LineMarks = { speakers: new Map([[0, 'A'], [1, 'B, then A'], [3, 'B'], [4, 'A']]), reactions: new Map(), topicStarts: new Set([3]) }

  it('names the speaker either side of a join, by the words nearest the join', () => {
    expect(joinFacts(at(1), at(4), marks)).toEqual([
      '    Speakers: Speaker A says the line before the join and the line after it.',
      '    Topic: the join crosses a topic change.'
    ])
    expect(joinFacts(at(0), at(3), marks)[0]).toBe('    Speakers: Speaker A says the line before the join; a different speaker, Speaker B, says the line after it.')
  })

  it('says nothing it does not know', () => {
    expect(joinFacts(at(4), at(5), marks)).toEqual([])
    expect(joinFacts(undefined, at(5), marks)).toEqual([])
    expect(joinFacts(at(0), at(2), NO_MARKS)).toEqual([])
  })
})

describe('playedText with marks', () => {
  it('marks the lines the audience reacted to', () => {
    const c = { suggestedStart: at(0).start - 0.1, suggestedEnd: at(2).end + 0.1, edit: { start: at(0).start - 0.1, end: at(2).end + 0.1 } } as unknown as Clip
    const marks: LineMarks = { ...NO_MARKS, reactions: new Map([[1, 'laughter']]) }
    expect(playedText(c, sentences, 900, marks)).toBe('So what happened next? We lost everything that day. [laughter] That must have hurt.')
    expect(playedText(c, sentences)).toBe('So what happened next? We lost everything that day. That must have hurt.')
  })
})
