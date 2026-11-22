import { expect, it, vi } from 'vitest'
import { MediaQueue } from '../src/main/pipeline/mediaJobs'

it('bounds work globally, prioritizes exports, and removes cancelled waiting jobs', async () => {
  const queue = new MediaQueue(() => 1)
  const order: string[] = []
  let finish!: () => void
  const active = queue.run(() => new Promise<void>(resolve => { finish = resolve }))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const background = queue.run(async () => { order.push('background') })
  const controller = new AbortController()
  const cancelled = queue.run(async () => { order.push('cancelled') }, controller.signal)
  const rejected = expect(cancelled).rejects.toThrow()
  controller.abort()
  await rejected
  const foreground = queue.run(async () => { order.push('export') }, undefined, 1)
  expect(order).toEqual([])
  finish()
  await Promise.all([active, background, foreground])
  expect(order).toEqual(['export', 'background'])
})

it('releases capacity after failure and adapts when the device budget changes', async () => {
  let limit = 2, count = 0, peak = 0
  const queue = new MediaQueue(() => limit)
  const work = async (): Promise<void> => {
    count++; peak = Math.max(count, peak)
    await new Promise(resolve => setTimeout(resolve, 10))
    count--
  }
  await expect(queue.run(async () => { throw Error('failed') })).rejects.toThrow('failed')
  await Promise.all([queue.run(work), queue.run(work), queue.run(work)])
  expect(peak).toBe(2)
  limit = 1; peak = 0
  await Promise.all([queue.run(work), queue.run(work)])
  expect(peak).toBe(1)
})

it('never exceeds its own ceiling, whatever the device budget reports', async () => {
  let count = 0, peak = 0
  const work = async (): Promise<void> => {
    count++; peak = Math.max(count, peak)
    await new Promise(resolve => setTimeout(resolve, 5))
    count--
  }
  const narrow = new MediaQueue(() => 8)
  await Promise.all(Array.from({ length: 6 }, () => narrow.run(work)))
  expect(peak).toBe(2)
  peak = 0
  const wide = new MediaQueue(() => 8, 4)
  await Promise.all(Array.from({ length: 6 }, () => wide.run(work)))
  expect(peak).toBe(4)
})
