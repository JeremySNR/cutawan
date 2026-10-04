import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrollItem, Clip, Transcript } from '@shared/types'
import { wordsInRange } from '@shared/captionLayout'
import { chatJSON } from './openai'
import { webBrollProvider, type BrollProvider } from './brollProviders'
import { projectDir } from '../projects'

/**
 * AI B-roll: finds spoken keywords worth illustrating (characters, people,
 * places, objects — "when I say Yoda, show Yoda") and attaches downloaded
 * images timed to the exact word. With a Metachlorian library as the source,
 * it asks for footage to cut away to instead, and attaches video inserts.
 */

interface RawSuggestion {
  trigger: string
  query: string
  start: number
  duration: number
  mode: 'fullscreen' | 'overlay'
}

interface SuggestionResponse {
  items: RawSuggestion[]
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['trigger', 'query', 'start', 'duration', 'mode'],
        properties: {
          trigger: {
            type: 'string',
            description: 'The exact spoken word/phrase that triggers the image, e.g. "Yoda"'
          },
          query: {
            type: 'string',
            description:
              'Specific image search query that unambiguously identifies the visual, e.g. "Yoda Star Wars character"'
          },
          start: {
            type: 'number',
            description: 'Seconds (from the provided word timestamps) when the trigger word is spoken'
          },
          duration: { type: 'number', description: 'How long to show the image, 2 to 4 seconds' },
          mode: {
            type: 'string',
            enum: ['fullscreen', 'overlay'],
            description:
              'fullscreen replaces the whole frame for a strong reveal; overlay is a smaller panel over the speaker'
          }
        }
      }
    }
  }
} as const

/** Footage libraries match descriptions of shots, not names of things. */
const FOOTAGE_SYSTEM_PROMPT = `You suggest B-roll cutaways for a short talking-head social video, to be found in a stock-footage library. You receive the clip's transcript as words with start timestamps.

Rules:
- Pick moments where cutting away to footage adds impact: a described action, place, object or situation ("typing all night", "the office", "our warehouse", "a busy street").
- Only suggest a cutaway when footage genuinely helps. Quality over quantity.
- At most one insert per ~8 seconds of clip; never let inserts overlap; total inserts must cover less than 40% of the clip.
- "start" MUST be the timestamp of the trigger word from the transcript (the footage appears as the word is spoken).
- duration: 2-4 seconds, never past the end of the clip.
- Queries describe the shot you want to see, the way an editor searches a footage library: subject, action, framing and mood ("hands typing on a laptop close-up", "aerial city traffic at night", "team laughing around a meeting table"). No names of people, brands or films.
- mode: fullscreen for most cutaways; overlay only when the speaker's reaction matters.
- Return an empty list when nothing is worth illustrating.`

const SYSTEM_PROMPT = `You suggest B-roll image inserts for a short talking-head social video. You receive the clip's transcript as words with start timestamps.

Rules:
- Pick concrete, visual, unambiguous references: named characters, people, places, films, products, animals, objects ("Yoda", "Millennium Falcon", "Tokyo"). Skip abstract words (ideas, feelings, "algorithm").
- Only suggest a reference when seeing it genuinely adds impact. Quality over quantity.
- At most one insert per ~8 seconds of clip; never let inserts overlap; total inserts must cover less than 40% of the clip.
- "start" MUST be the timestamp of the trigger word from the transcript (the image appears as the word is spoken).
- duration: 2-4 seconds, never past the end of the clip.
- Search queries must be specific enough to return the right image on Wikipedia (add the franchise/context: "Yoda Star Wars", not just "Yoda").
- mode: fullscreen for big reveals (first mention of a main subject), overlay for passing references.
- Return an empty list when nothing is worth illustrating.`

export async function suggestBroll(
  apiKey: string,
  model: string,
  transcript: Transcript,
  clip: Clip,
  signal?: AbortSignal,
  queryStyle: BrollProvider['queryStyle'] = 'image'
): Promise<Array<Omit<BrollItem, 'imagePath'>>> {
  const words = wordsInRange(transcript, clip.edit.start, clip.edit.end)
  if (words.length === 0) return []
  const clipDur = clip.edit.end - clip.edit.start
  const wordList = words.map((w) => `${w.start.toFixed(2)}s ${w.text}`).join('\n')

  const res = await chatJSON<SuggestionResponse>(
    apiKey,
    model,
    [
      { role: 'system', content: queryStyle === 'footage' ? FOOTAGE_SYSTEM_PROMPT : SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Clip runs from ${clip.edit.start.toFixed(2)}s to ${clip.edit.end.toFixed(2)}s (${clipDur.toFixed(1)}s long). Timestamps below are absolute.\n\nTranscript words:\n${wordList}`
      }
    ],
    'broll_suggestions',
    RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    signal
  )

  const items: Array<Omit<BrollItem, 'imagePath'>> = []
  let lastEnd = -Infinity
  for (const raw of res.items ?? []) {
    const start = Math.max(clip.edit.start, Math.min(raw.start, clip.edit.end - 1.5))
    const duration = Math.max(1.5, Math.min(4, raw.duration))
    const end = Math.min(clip.edit.end - 0.2, start + duration)
    if (end - start < 1.2) continue
    if (start < lastEnd + 1) continue // enforce no overlap / breathing room
    lastEnd = end
    items.push({
      id: randomUUID(),
      trigger: raw.trigger,
      query: raw.query,
      start,
      end,
      mode: raw.mode === 'fullscreen' ? 'fullscreen' : 'overlay',
      sourceUrl: '',
      enabled: true
    })
  }
  return items
}

/** Suggest, search and download B-roll for one clip. Mutates clip.broll. */
export async function attachBroll(
  apiKey: string,
  model: string,
  transcript: Transcript,
  projectId: string,
  clip: Clip,
  signal?: AbortSignal,
  provider: BrollProvider = webBrollProvider
): Promise<void> {
  const suggestions = await suggestBroll(apiKey, model, transcript, clip, signal, provider.queryStyle)
  const destDir = join(projectDir(projectId), 'broll')
  const items: BrollItem[] = []
  for (const suggestion of suggestions) {
    signal?.throwIfAborted()
    const found = await provider.find(
      { trigger: suggestion.trigger, query: suggestion.query, durationSec: suggestion.end - suggestion.start },
      destDir,
      `${clip.id}-${suggestion.id}`,
      signal
    )
    if (!found) continue
    // A shot shorter than the slot ends the insert early rather than freezing.
    const end = found.maxDurationSec !== undefined
      ? Math.min(suggestion.end, suggestion.start + found.maxDurationSec)
      : suggestion.end
    items.push({
      ...suggestion,
      end,
      imagePath: found.path,
      sourceUrl: found.sourceUrl,
      ...(found.kind === 'video' ? { kind: 'video' as const, mediaIn: found.mediaIn ?? 0 } : {})
    })
  }
  clip.broll = items
}
