import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SUBSCRIPTION } from '../src/shared/subscription'

/**
 * Issue #83: on the ChatGPT route one slow request used to lose the whole
 * Get clips run. Each Codex run below is scripted: answer, hang, or exit
 * without closing its output pipes.
 */
type Behaviour = 'answer' | 'hang' | 'hang-after-writing' | 'exit-without-close'
const mock = vi.hoisted(() => ({ root: '', spawn: vi.fn(), script: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root, getAppPath: () => mock.root, isPackaged: false, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
import { configureSubscription, setProviderTimeoutsForTests, subscriptionJSON } from '../src/main/subscription'

const messages = [{ role: 'user' as const, content: 'Pick a complete moment.' }]
const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }
const ANSWER = { title: 'A complete story' }
const execCalls = (): number => mock.spawn.mock.calls.filter((call) => call[1][0] === 'exec').length
const usage = async (): Promise<number> => JSON.parse(await readFile(join(mock.root, 'subscription-usage.json'), 'utf8')).requests

beforeEach(async () => {
  mock.root = await mkdtemp(join(tmpdir(), 'cutawan-subscription-timeout-'))
  mock.script = []
  mock.spawn.mockReset().mockImplementation((_exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      // A killed process closes its pipes.
      kill: vi.fn(() => { setTimeout(() => child.emit('close', null), 1) })
    })
    const behaviour = (args[0] === 'exec' ? mock.script.shift() : 'answer') as Behaviour
    setTimeout(() => { void (async () => {
      if (args[0] === 'login') { child.stderr.emit('data', 'Logged in using ChatGPT'); child.emit('close', 0); return }
      if (behaviour !== 'hang') await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(ANSWER))
      if (behaviour === 'hang' || behaviour === 'hang-after-writing') { child.stderr.emit('data', 'stream stalled'); return }
      if (behaviour === 'exit-without-close') { child.emit('exit', 0); return }
      child.emit('close', 0)
    })() }, 5)
    return child
  })
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'chatgpt', dailyRequestLimit: 10 })
  setProviderTimeoutsForTests({ requestMs: 200, loginMs: 200, exitGraceMs: 50 })
})
afterEach(async () => {
  await rm(mock.root, { recursive: true, force: true })
  configureSubscription(DEFAULT_SUBSCRIPTION)
  setProviderTimeoutsForTests({ requestMs: 5 * 60_000, loginMs: 15_000, exitGraceMs: 5_000 })
})

it('retries once when a request times out, and counts both attempts', async () => {
  mock.script = ['hang', 'answer']
  expect(await subscriptionJSON(messages, schema)).toEqual(ANSWER)
  expect(execCalls()).toBe(2)
  expect(await usage()).toBe(2)
})

it('takes an answer already written by a run that then hung, without another request', async () => {
  mock.script = ['hang-after-writing']
  expect(await subscriptionJSON(messages, schema)).toEqual(ANSWER)
  expect(execCalls()).toBe(1)
})

it('settles soon after the launcher exits even if its output pipe never closes', async () => {
  mock.script = ['exit-without-close']
  const started = Date.now()
  expect(await subscriptionJSON(messages, schema)).toEqual(ANSWER)
  expect(execCalls()).toBe(1)
  expect(Date.now() - started).toBeLessThan(180) // well inside the 200 ms request limit
})

it('says it timed out, with the last output, after two slow attempts', async () => {
  mock.script = ['hang', 'hang']
  const error = (await subscriptionJSON(messages, schema).catch((e: unknown) => e)) as Error
  expect(error.message).toMatch(/did not answer within .* twice/)
  expect(error.message).toContain('stream stalled')
  expect(error.message).not.toMatch(/cancelled/)
  expect(execCalls()).toBe(2)
})

it('never retries a cancel', async () => {
  mock.script = ['hang', 'answer']
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 60)
  const error = (await subscriptionJSON(messages, schema, controller.signal).catch((e: unknown) => e)) as Error
  expect(error.message).toMatch(/cancel/i)
  expect(execCalls()).toBe(1)
})
