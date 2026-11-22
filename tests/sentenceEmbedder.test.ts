import { describe, expect, it } from 'vitest'
import { basicTokens, defaultSentenceEmbedder, encode, meanPool, parseVocab, wordPiece } from '../src/main/pipeline/sentenceEmbedder'

/** A few lines of a BERT-style vocabulary: specials, words and "##" continuations. */
const vocab = parseVocab(['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', ',', 'world', '!', 'cafe', 'isn', "'", 't', 'un', '##aff', '##able', '.', '中', '文'].join('\n'))

describe('parseVocab', () => {
  it('gives each token its line number and finds the special tokens', () => {
    expect(vocab.ids.get('hello')).toBe(4)
    expect([vocab.pad, vocab.unk, vocab.cls, vocab.sep]).toEqual([0, 1, 2, 3])
  })

  it('refuses a vocabulary without the special tokens', () => {
    expect(() => parseVocab('hello\nworld')).toThrow(/\[CLS\]/)
  })
})

describe('basicTokens', () => {
  it('lowercases, strips accents and splits off punctuation as BERT uncased does', () => {
    expect(basicTokens("Hello, World! Café isn't")).toEqual(['hello', ',', 'world', '!', 'cafe', 'isn', "'", 't'])
  })

  it('spaces CJK characters apart and drops control characters', () => {
    expect(basicTokens('中文\u0000ok\tthen')).toEqual(['中', '文', 'ok', 'then'])
  })
})

describe('wordPiece', () => {
  it('splits a word into the longest pieces the vocabulary has', () => {
    expect(wordPiece('unaffable', vocab)).toEqual([12, 13, 14])
    expect(wordPiece('hello', vocab)).toEqual([4])
  })

  it('maps a word it cannot spell, or one too long, to [UNK]', () => {
    expect(wordPiece('zebra', vocab)).toEqual([vocab.unk])
    expect(wordPiece('hello', vocab, 3)).toEqual([vocab.unk])
  })
})

describe('encode', () => {
  it('wraps the pieces in [CLS] and [SEP]', () => {
    expect(encode('Hello, world!', vocab)).toEqual([2, 4, 5, 6, 7, 3])
  })

  it('truncates to the token limit, keeping [SEP] last', () => {
    const ids = encode('hello '.repeat(50), vocab, 8)
    expect(ids).toHaveLength(8)
    expect(ids[0]).toBe(vocab.cls)
    expect(ids[7]).toBe(vocab.sep)
  })
})

describe('meanPool', () => {
  it('averages only the unmasked token vectors and normalises the result', () => {
    // Batch of 2, 3 tokens, 2 dims.
    const hidden = new Float32Array([
      1, 0, 3, 0, 100, 100,
      0, 2, 0, 2, 0, 2
    ])
    const [a, b] = meanPool(hidden, [[1, 1, 0], [1, 1, 1]], 3, 2)
    expect(Array.from(a)).toEqual([1, 0])
    expect(Array.from(b)).toEqual([0, 1])
  })
})

describe('defaultSentenceEmbedder', () => {
  it('is off outside the app unless asked, so tests never download a model', async () => {
    expect(process.env.CUTAWAN_TOPICS).toBeUndefined()
    expect(await defaultSentenceEmbedder()).toBeNull()
  })
})
