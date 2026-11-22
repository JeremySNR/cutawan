import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { InferenceClient } from '../src/main/inference/client'

const clients: InferenceClient[] = []
const input = { input: { data: new Float32Array([1, 2, 3]), dims: [1, 3] } }
function client(timeout = 3000): InferenceClient {
  const instance = new InferenceClient(join(process.cwd(), 'tests/fixtures/inference-worker.cjs'), [], timeout)
  clients.push(instance)
  return instance
}
afterEach(() => { for (const instance of clients.splice(0)) instance.close() })

describe('isolated native inference', () => {
  it('preserves typed tensor data across IPC and serializes queued calls', async () => {
    const instance = client()
    const results = await Promise.all([instance.run('ok', input), instance.run('ok', input)])
    for (const output of results) {
      expect(output.input.data).toBeInstanceOf(Float32Array)
      expect(output.input).toEqual(input.input)
    }
  })

  it('contains child exits and rejects queued work without a crash/restart loop', async () => {
    const instance = client()
    const results = await Promise.allSettled([instance.run('crash', input), instance.run('ok', input)])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    await expect(instance.run('ok', input)).rejects.toThrow('inference process failed')
  })

  it('names the feature that stopped when a dedicated child fails', async () => {
    const instance = new InferenceClient(join(process.cwd(), 'tests/fixtures/inference-worker.cjs'), [], 3000, 'Speaker detection')
    clients.push(instance)
    await expect(instance.run('crash', input)).rejects.toThrow(/^Speaker detection stopped because the inference process failed/)
  })

  it('kills hung inference when cancelled and permits a later request', async () => {
    const instance = client()
    const abort = new AbortController()
    const pending = instance.run('hang', input, abort.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await new Promise(resolve => setTimeout(resolve, 100))
    abort.abort()
    await rejected
    await expect(instance.run('ok', input)).resolves.toEqual(input)
  })

  it('does not send already-cancelled work and contains a timeout', async () => {
    const instance = client(200)
    await expect(instance.run('ok', input, AbortSignal.abort())).rejects.toThrow()
    await expect(instance.run('hang', input)).rejects.toThrow('timed out')
  })

  it('reports a model error without disabling healthy subsequent requests', async () => {
    const instance = client()
    await expect(instance.run('error', input)).rejects.toThrow('bad model')
    await expect(instance.run('ok', input)).resolves.toEqual(input)
  })
})
