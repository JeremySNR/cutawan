import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { app } from 'electron'
import { createInferenceClient } from '../inference/client'

let topicClient: ReturnType<typeof createInferenceClient> | undefined
/**
 * Its own inference child, like diarization's: a failure in the topic model
 * latches its client until restart, and must not switch off automatic
 * framing, which uses the shared one.
 */
const runInference: ReturnType<typeof createInferenceClient>['run'] = (...args) => {
  topicClient ??= createInferenceClient(undefined, 'Topic detection')
  return topicClient.run(...args)
}
import type { SentenceEmbedder } from './topics'

/**
 * A small local sentence-embedding model for topic detection:
 * all-MiniLM-L6-v2 (sentence-transformers; Apache-2.0), as the int8-quantised
 * ONNX export published at Xenova/all-MiniLM-L6-v2, with the BERT uncased
 * WordPiece vocabulary it was trained with. 384-dimensional mean-pooled,
 * L2-normalised vectors, the model's reference pooling. About 23 MB, so it is
 * not bundled: it is downloaded into userData the first time topic detection
 * runs, checked against the SHA-256 recorded here, and reused after that.
 * When it cannot be had (offline, a changed upstream file, outside the app)
 * topic detection is skipped and clip selection runs as before. Source and
 * licence: resources/models/all-MiniLM-L6-v2-source.md.
 */

export const EMBEDDER_ID = 'all-MiniLM-L6-v2-int8'

interface ModelFile {
  name: string
  url: string
  sha256: string
  bytes: number
}

const MODEL_FILE: ModelFile = {
  name: 'model_quantized.onnx',
  url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx',
  sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
  bytes: 22972370
}

const VOCAB_FILE: ModelFile = {
  name: 'vocab.txt',
  url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt',
  sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  bytes: 231508
}

/** Longest a first-run download may hold up an analysis before it goes on without topics. */
const DOWNLOAD_DEADLINE_MS = 90_000
/** The model's own sequence limit is 256; spoken sentences are far shorter, and the tokenizer config truncates at 128. */
const MAX_TOKENS = 128

function modelDir(): string {
  const base = app?.getPath?.('userData') ?? join(process.cwd(), '.tmp', 'userData')
  return join(base, 'models', 'all-MiniLM-L6-v2')
}

/**
 * Whether this process may use (and fetch) the model. Inside the app, yes.
 * Outside it (unit tests, the tsx scripts) only when asked with
 * CUTAWAN_TOPICS=1, so a test run never touches the network or silently
 * changes what the selection prompt contains.
 */
function topicsAllowed(): boolean {
  return app !== undefined || process.env.CUTAWAN_TOPICS === '1'
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Files already verified this session, so a large model is hashed once per run of the app. */
const verified = new Set<string>()

async function fileReady(path: string, file: ModelFile): Promise<boolean> {
  try {
    if ((await stat(path)).size !== file.bytes) return false
    if (verified.has(path)) return true
    if ((await sha256File(path)) !== file.sha256) return false
    verified.add(path)
    return true
  } catch {
    return false
  }
}

/**
 * Download one file next to its destination, hashing as it streams, and
 * rename it into place only when its size and SHA-256 match. A mismatch (the
 * upstream file changed, a proxy rewrote it) leaves nothing behind.
 */
async function download(file: ModelFile, dest: string, signal: AbortSignal): Promise<void> {
  const temporary = `${dest}.${randomUUID()}.part`
  try {
    const res = await fetch(file.url, { redirect: 'follow', signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.name}`)
    const hash = createHash('sha256')
    let received = 0
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        if (received > file.bytes) return done(new Error(`${file.name} is larger than expected`))
        hash.update(chunk)
        done(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), tap, createWriteStream(temporary), { signal })
    const digest = hash.digest('hex')
    if (received !== file.bytes || digest !== file.sha256) {
      throw new Error(`${file.name} did not match its recorded checksum (got ${received} bytes, sha256 ${digest})`)
    }
    await rename(temporary, dest)
    verified.add(dest)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A failed download is not retried on every analysis of the same session. */
let downloadFailed = false

/**
 * The model and vocabulary paths, downloading them on first use; null when
 * they are not there and cannot be fetched. Never throws for a missing model;
 * cancellation propagates.
 */
export async function ensureSentenceModel(signal?: AbortSignal, onDownload?: () => void): Promise<{ model: string; vocab: string } | null> {
  const dir = modelDir()
  const model = join(dir, MODEL_FILE.name)
  const vocab = join(dir, VOCAB_FILE.name)
  const [modelOk, vocabOk] = await Promise.all([fileReady(model, MODEL_FILE), fileReady(vocab, VOCAB_FILE)])
  if (modelOk && vocabOk) return { model, vocab }
  if (!topicsAllowed() || downloadFailed) return null
  const deadline = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    onDownload?.()
    await mkdir(dir, { recursive: true })
    if (!vocabOk) await download(VOCAB_FILE, vocab, combined)
    if (!modelOk) await download(MODEL_FILE, model, combined)
    return { model, vocab }
  } catch (err) {
    signal?.throwIfAborted()
    downloadFailed = true
    console.error('Could not download the topic model; clips are chosen without topic boundaries this session:', err)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* WordPiece tokenizer (BERT uncased), as the model's tokenizer.json   */
/* specifies: BertNormalizer (clean text, CJK spacing, lowercase,      */
/* strip accents), BertPreTokenizer (whitespace and punctuation), then */
/* greedy longest-match WordPiece with "##" continuations.             */
/* ------------------------------------------------------------------ */

export interface WordPieceVocab {
  ids: Map<string, number>
  cls: number
  sep: number
  pad: number
  unk: number
}

/** Parse vocab.txt: one token per line, the line number is its id. Exported for tests. */
export function parseVocab(text: string): WordPieceVocab {
  const ids = new Map<string, number>()
  text.split('\n').forEach((line, i) => {
    const token = line.replace(/\r$/, '')
    if (token.length > 0 && !ids.has(token)) ids.set(token, i)
  })
  const special = (t: string): number => {
    const id = ids.get(t)
    if (id === undefined) throw new Error(`The vocabulary has no ${t} token`)
    return id
  }
  return { ids, cls: special('[CLS]'), sep: special('[SEP]'), pad: special('[PAD]'), unk: special('[UNK]') }
}

function isPunctuation(cp: number): boolean {
  // BERT treats every ASCII non-alphanumeric printable as punctuation, plus Unicode P* categories.
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return /\p{P}/u.test(String.fromCodePoint(cp))
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
}

/** BERT's basic tokenization: normalised words and punctuation marks. Exported for tests. */
export function basicTokens(text: string): string[] {
  let cleaned = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0 || cp === 0xfffd || (/\p{Cc}/u.test(ch) && !/[\t\n\r]/.test(ch))) continue
    if (/\s/u.test(ch)) cleaned += ' '
    else if (isCjk(cp)) cleaned += ` ${ch} `
    else cleaned += ch
  }
  // Lowercase, then strip accents (NFD and drop combining marks), as the uncased model was trained.
  const normalised = cleaned.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')
  const out: string[] = []
  for (const word of normalised.split(' ')) {
    if (!word) continue
    let current = ''
    for (const ch of word) {
      if (isPunctuation(ch.codePointAt(0) ?? 0)) {
        if (current) out.push(current)
        out.push(ch)
        current = ''
      } else current += ch
    }
    if (current) out.push(current)
  }
  return out
}

/** Greedy longest-match WordPiece over one basic token. Exported for tests. */
export function wordPiece(token: string, vocab: WordPieceVocab, maxChars = 100): number[] {
  const chars = [...token]
  if (chars.length > maxChars) return [vocab.unk]
  const ids: number[] = []
  let start = 0
  while (start < chars.length) {
    let end = chars.length
    let found: number | undefined
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('')
      found = vocab.ids.get(piece)
      if (found !== undefined) break
      end--
    }
    if (found === undefined) return [vocab.unk]
    ids.push(found)
    start = end
  }
  return ids
}

/** [CLS] tokens… [SEP], truncated to `maxTokens` in all. Exported for tests. */
export function encode(text: string, vocab: WordPieceVocab, maxTokens = MAX_TOKENS): number[] {
  const ids: number[] = []
  for (const token of basicTokens(text)) {
    ids.push(...wordPiece(token, vocab))
    if (ids.length >= maxTokens - 2) break
  }
  return [vocab.cls, ...ids.slice(0, maxTokens - 2), vocab.sep]
}

/**
 * Mean of the token vectors where the mask is set, then L2-normalised: the
 * pooling all-MiniLM-L6-v2 was trained with. `hidden` is [batch, seq, dim]
 * row-major. Exported for tests.
 */
export function meanPool(hidden: Float32Array, mask: number[][], seq: number, dim: number): Float32Array[] {
  return mask.map((row, b) => {
    const out = new Float32Array(dim)
    let count = 0
    for (let t = 0; t < seq; t++) {
      if (!row[t]) continue
      count++
      const offset = (b * seq + t) * dim
      for (let d = 0; d < dim; d++) out[d] += hidden[offset + d]
    }
    let norm = 0
    for (let d = 0; d < dim; d++) {
      out[d] /= Math.max(1, count)
      norm += out[d] * out[d]
    }
    norm = Math.sqrt(norm)
    if (norm > 0) for (let d = 0; d < dim; d++) out[d] /= norm
    return out
  })
}

/** The embedder over a model and vocabulary on disk; inference runs in its own ONNX child process. */
export function miniLmEmbedder(modelPath: string, vocab: WordPieceVocab): SentenceEmbedder {
  return {
    id: EMBEDDER_ID,
    async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const encoded = texts.map((t) => encode(t, vocab))
      // Padded to the longest in the batch, not to 128: most lines are short.
      const seq = Math.max(...encoded.map((ids) => ids.length))
      const ids = new BigInt64Array(texts.length * seq)
      const attention = new BigInt64Array(texts.length * seq)
      const mask: number[][] = encoded.map((row, b) => {
        const m = new Array<number>(seq).fill(0)
        row.forEach((id, t) => {
          ids[b * seq + t] = BigInt(id)
          attention[b * seq + t] = 1n
          m[t] = 1
        })
        for (let t = row.length; t < seq; t++) ids[b * seq + t] = BigInt(vocab.pad)
        return m
      })
      const dims = [texts.length, seq]
      const out = await runInference(modelPath, {}, signal, undefined, {
        input_ids: { data: ids, dims },
        attention_mask: { data: attention, dims },
        token_type_ids: { data: new BigInt64Array(texts.length * seq), dims }
      })
      const hidden = out.last_hidden_state
      if (!hidden || hidden.dims.length !== 3) throw new Error('The topic model returned no token vectors.')
      return meanPool(hidden.data, mask, seq, Number(hidden.dims[2]))
    }
  }
}

/**
 * The default embedder: the downloaded MiniLM, or null when topic detection
 * cannot run here (outside the app unless CUTAWAN_TOPICS=1, or no model).
 */
export async function defaultSentenceEmbedder(signal?: AbortSignal, onDownload?: () => void): Promise<SentenceEmbedder | null> {
  if (!topicsAllowed()) return null
  const paths = await ensureSentenceModel(signal, onDownload)
  if (!paths) return null
  try {
    return miniLmEmbedder(paths.model, parseVocab(await readFile(paths.vocab, 'utf8')))
  } catch (err) {
    console.error('Could not load the topic model vocabulary; clips are chosen without topic boundaries:', err)
    return null
  }
}
