import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SUBSCRIPTION, normalizeSubscription } from '../src/shared/subscription'

const mock = vi.hoisted(() => ({ root: '', spawn: vi.fn(), login: 'Logged in using ChatGPT', fail: false, delay: 0, active: 0, peak: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root, getAppPath: () => mock.root, isPackaged: false, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
import { configureSubscription, subscriptionJSON, subscriptionEnvironment, codexArguments, resolveCodexExecutable, SubscriptionError, usesLocalTranscription } from '../src/main/subscription'

const messages = [{ role: 'user' as const, content: 'Pick a complete moment.' }]
const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }
beforeEach(async () => {
  mock.root = await mkdtemp(join(tmpdir(), 'cutawan-subscription-test-'))
  mock.login = 'Logged in using ChatGPT'
  mock.fail = false
  mock.delay = mock.active = mock.peak = 0
  mock.spawn.mockReset().mockImplementation((_exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() })
    if (args[0] === 'exec') { mock.active++; mock.peak = Math.max(mock.peak, mock.active) }
    setTimeout(() => { void (async () => {
      if (args[0] === 'login') child.stderr.emit('data', mock.login)
      else if (!mock.fail) await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ title: 'A complete story' }))
      if (args[0] === 'exec') mock.active--
      child.emit('close', args[0] !== 'login' && mock.fail ? 1 : 0)
    })() }, args[0] === 'exec' ? mock.delay : 0)
    return child
  })
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'chatgpt', dailyRequestLimit: 1 })
})
afterEach(async () => { await rm(mock.root, { recursive: true, force: true }); configureSubscription(DEFAULT_SUBSCRIPTION) })

it('keeps legacy settings on API and normalizes request limits', () => {
  expect(normalizeSubscription().provider).toBe('api')
  expect(normalizeSubscription().localTranscription).toBe(false)
  expect(normalizeSubscription({ dailyRequestLimit: -1 }).dailyRequestLimit).toBe(0)
  expect(normalizeSubscription({ dailyRequestLimit: NaN }).dailyRequestLimit).toBe(10)
})
it('can transcribe locally while analysis remains on the API route', () => {
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'api', localTranscription: true })
  expect(usesLocalTranscription()).toBe(true)
  configureSubscription(DEFAULT_SUBSCRIPTION)
  expect(usesLocalTranscription()).toBe(false)
})
it('finds the standalone Codex install when a GUI process has a limited PATH', async () => {
  const installDir = join(mock.root, '.local', 'bin')
  await mkdir(installDir, { recursive: true })
  const executable = join(installDir, 'codex')
  await writeFile(executable, '')
  await chmod(executable, 0o755)
  expect(resolveCodexExecutable('codex', '/usr/bin', mock.root, 'darwin')).toBe(executable)
  expect(resolveCodexExecutable('/custom/codex', '/usr/bin', mock.root, 'darwin')).toBe('/custom/codex')
})
it('pins the requested model and low reasoning and removes API billing credentials', () => {
  const args = codexArguments('gpt-5.6-luna', '/job', [])
  expect(args).toContain('gpt-5.6-luna')
  expect(args).toContain('forced_login_method="chatgpt"')
  expect(args).toContain('model_reasoning_effort="low"')
  expect(subscriptionEnvironment({ OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret', PATH: '/bin' })).toEqual({ PATH: '/bin' })
})
it('reuses cached analysis with cap zero without invoking Codex again', async () => {
  const first = await subscriptionJSON(messages, schema)
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'chatgpt', dailyRequestLimit: 0 })
  expect(await subscriptionJSON(messages, schema)).toEqual(first)
  expect(mock.spawn).toHaveBeenCalledTimes(2) // login status + one inference
})
it('serializes budget reservations so concurrent requests cannot overspend the cap', async () => {
  const results = await Promise.allSettled([
    subscriptionJSON(messages, schema),
    subscriptionJSON([{ role: 'user', content: 'Another moment' }], schema)
  ])
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(mock.spawn.mock.calls.filter(call => call[1][0] === 'exec')).toHaveLength(1)
  expect(JSON.parse(await readFile(join(mock.root, 'subscription-usage.json'), 'utf8')).requests).toBe(1)
})
it('rejects API-key login before inference and without reserving usage', async () => {
  mock.login = 'Logged in using an API key'
  await expect(subscriptionJSON(messages, schema)).rejects.toThrow('Sign in to Codex with ChatGPT')
  expect(mock.spawn).toHaveBeenCalledTimes(1)
})
it('counts failed inference and never silently retries or falls back', async () => {
  mock.fail = true
  await expect(subscriptionJSON(messages, schema)).rejects.toBeInstanceOf(SubscriptionError)
  await expect(subscriptionJSON(messages, schema)).rejects.toThrow('request cap reached')
  expect(mock.spawn).toHaveBeenCalledTimes(2)
})
it('does not reuse another model’s cached output', async () => {
  await subscriptionJSON(messages, schema)
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'chatgpt', codexModel: 'another-model', dailyRequestLimit: 1 })
  await expect(subscriptionJSON(messages, schema)).rejects.toThrow('request cap reached')
})
it('does not make any requests after cancellation', async () => {
  await expect(subscriptionJSON(messages, schema, AbortSignal.abort())).rejects.toBeInstanceOf(SubscriptionError)
  expect(mock.spawn).not.toHaveBeenCalled()
})

it('fails closed when another process holds the usage reservation', async () => {
  await writeFile(join(mock.root, 'subscription-usage.lock'), '')
  await expect(subscriptionJSON(messages, schema)).rejects.toThrow('Could not reserve ChatGPT usage')
  expect(mock.spawn).toHaveBeenCalledTimes(1) // authentication only
})

it('does not reset a damaged usage ledger and spend again', async () => {
  await writeFile(join(mock.root, 'subscription-usage.json'), '{"requests":-1}')
  await expect(subscriptionJSON(messages, schema)).rejects.toThrow('usage record is invalid')
  expect(mock.spawn).not.toHaveBeenCalled()
})

it('routes analysis to Codex without calling the REST API', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  try {
    const { chatJSON } = await import('../src/main/pipeline/openai')
    expect(await chatJSON('unused-key', 'ignored-api-model', messages, 'test', schema)).toEqual({ title: 'A complete story' })
    expect(fetch).not.toHaveBeenCalled()
  } finally { fetch.mockRestore() }
})

it('stops a running inference on cancellation, including its Windows process tree', async () => {
  let active: EventEmitter | undefined
  const controller = new AbortController()
  mock.spawn.mockImplementation((exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1357911, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: () => { setTimeout(() => child.emit('close', 1), 0); return true }
    })
    if (exe === 'taskkill.exe') setTimeout(() => { active?.emit('close', 1); child.emit('close', 0) }, 0)
    else if (args[0] === 'login') setTimeout(() => { child.stderr.emit('data', mock.login); child.emit('close', 0) }, 0)
    else { active = child; setTimeout(() => controller.abort(), 0) }
    return child
  })
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { setTimeout(() => active?.emit('close', 1), 0); return true })
  try {
    await expect(subscriptionJSON(messages, schema, controller.signal)).rejects.toThrow('Local provider cancelled.')
    if (process.platform === 'win32') expect(mock.spawn).toHaveBeenCalledWith('taskkill.exe', ['/PID', '1357911', '/T', '/F'], expect.objectContaining({ windowsHide: true, shell: false }))
    else expect(kill).toHaveBeenCalledWith(-1357911, 'SIGTERM')
  } finally { kill.mockRestore() }
})


it('overlaps independent requests with a maximum of two and reserves every request', async () => {
  configureSubscription({ ...DEFAULT_SUBSCRIPTION, provider: 'chatgpt', dailyRequestLimit: 3 })
  mock.delay = 50
  await Promise.all(['one', 'two', 'three'].map(content => subscriptionJSON([{ role: 'user', content }], schema)))
  // Low-memory hosts intentionally keep the admission limit at one.
  const { totalmem } = await import('node:os')
  expect(mock.peak).toBeGreaterThanOrEqual(1)
  expect(mock.peak).toBeLessThanOrEqual(2)
  if (totalmem() >= 8 * 1024 ** 3) expect(mock.peak).toBe(2)
  expect(JSON.parse(await readFile(join(mock.root, 'subscription-usage.json'), 'utf8')).requests).toBe(3)
})
it('deduplicates simultaneous identical requests before reserving usage', async () => {
  mock.delay = 30
  const results = await Promise.all([subscriptionJSON(messages, schema), subscriptionJSON(messages, schema)])
  expect(results[0]).toEqual(results[1])
  expect(mock.spawn.mock.calls.filter(call => call[1][0] === 'exec')).toHaveLength(1)
  expect(JSON.parse(await readFile(join(mock.root, 'subscription-usage.json'), 'utf8')).requests).toBe(1)
})

it('cancels a duplicate waiter without cancelling the original request', async () => {
  mock.delay = 80
  const first = subscriptionJSON(messages, schema)
  const controller = new AbortController()
  const second = subscriptionJSON(messages, schema, controller.signal)
  controller.abort(new Error('Cancelled duplicate'))
  await expect(second).rejects.toThrow('Cancelled duplicate')
  const third = subscriptionJSON(messages, schema)
  expect(await first).toEqual({ title: 'A complete story' })
  expect(await third).toEqual({ title: 'A complete story' })
  expect(mock.spawn.mock.calls.filter(call => call[1][0] === 'exec')).toHaveLength(1)
})

describe('cmd.exe launcher quoting', () => {
  it('keeps paths with spaces and shell characters in one argument each', async () => {
    const { cmdLine } = await import('../src/main/subscription')
    expect(cmdLine(['C:\\Users\\Jane Doe\\miniconda3\\condabin\\python.cmd', 'C:\\Program Files\\Cutawan\\transcribe.py', 'a&b', 'say "hi"']))
      .toBe('"C:\\Users\\Jane Doe\\miniconda3\\condabin\\python.cmd" "C:\\Program Files\\Cutawan\\transcribe.py" "a&b" "say ""hi"""')
  })
})
