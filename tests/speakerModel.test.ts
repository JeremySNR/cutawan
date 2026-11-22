import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { downloadVerified, speakerModelPath } from '../src/main/pipeline/speakerModel'

const body = Buffer.from('not really a model, but bytes all the same')
const sha = createHash('sha256').update(body).digest('hex')
let server: Server
let base = ''
let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cutawan-speaker-model-'))
  server = createServer((req, res) => {
    if (req.url === '/model') { res.end(body); return }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('speaker model download', () => {
  it('keeps a download only when it matches the pinned checksum', async () => {
    const dest = join(dir, 'ok.onnx')
    await downloadVerified(`${base}/model`, dest, sha, 1000)
    expect(await readFile(dest)).toEqual(body)
  })

  it('refuses a checksum mismatch, an oversized file and an HTTP error, leaving nothing behind', async () => {
    const dest = join(dir, 'bad.onnx')
    await expect(downloadVerified(`${base}/model`, dest, '0'.repeat(64), 1000)).rejects.toThrow('checksum mismatch')
    await expect(downloadVerified(`${base}/model`, dest, sha, 10)).rejects.toThrow('larger than expected')
    await expect(downloadVerified(`${base}/missing`, dest, sha, 1000)).rejects.toThrow('HTTP 404')
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.download`)).toBe(false)
  })

  it('uses an explicit model path, and reports unavailable outside Electron without downloading', async () => {
    const file = join(dir, 'override.onnx')
    await writeFile(file, body)
    process.env.CUTAWAN_SPEAKER_MODEL = file
    try {
      expect(await speakerModelPath()).toBe(file)
      process.env.CUTAWAN_SPEAKER_MODEL = join(dir, 'absent.onnx')
      expect(await speakerModelPath()).toBeNull()
    } finally {
      delete process.env.CUTAWAN_SPEAKER_MODEL
    }
    // The electron stub has no userData, so there is nowhere to cache a download.
    expect(await speakerModelPath()).toBeNull()
  })
})
