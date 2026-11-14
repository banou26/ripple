// The engine follows the stored choice of the VPN by being replaced, one change at a time.
import { expect, it, vi } from 'vitest'

import { vpnFollower } from '../../src/torrent/vpn-follow'

/** A page that runs an engine: `started` holds the choice each engine was started on, the last being the one alive. */
const page = (over: Partial<Parameters<typeof vpnFollower>[0]> = {}) => {
  const state = { wanted: true, started: [true] as boolean[], owns: true, busy: false, flushed: 0 }
  const follow = vpnFollower({
    wanted: () => state.wanted,
    running: () => state.owns ? state.started.at(-1)! : null,
    busy: async () => state.busy,
    flush: async () => { state.flushed++ },
    restart: () => { state.started.push(state.wanted) },
    ...over,
  }, 5)
  return { state, follow }
}

it('replaces the engine once when the choice changes, after its resume data is written', async () => {
  const { state, follow } = page()
  state.wanted = false
  await follow()
  expect(state.started).toEqual([true, false])
  expect(state.flushed).toBe(1)
})

it('runs one change at a time: a call made meanwhile waits for it, and the engine is asked to write once', async () => {
  const { state, follow } = page()
  state.wanted = false
  await Promise.all([follow(), follow(), follow()])
  expect(state.started).toEqual([true, false])
  expect(state.flushed).toBe(1)
})

it('does nothing while the engine is already on the choice', async () => {
  const { state, follow } = page()
  await follow()
  expect(state.started).toEqual([true])
  expect(state.flushed).toBe(0)
})

it('does nothing in a page that runs no engine', async () => {
  const { state, follow } = page()
  state.owns = false
  state.wanted = false
  await follow()
  expect(state.started).toEqual([true])
})

it('ends 20 changes in a row on the last one, each engine started on the choice of its moment', async () => {
  const { state, follow } = page()
  const calls: Promise<void>[] = []
  for (let i = 0; i < 20; i++) {
    state.wanted = i % 2 === 1
    calls.push(follow())
    // some changes arrive within one step of the follower, some after it
    if (i % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await Promise.all(calls)
  expect(state.wanted).toBe(true)
  expect(state.started.at(-1), 'the engine alive at the end').toBe(true)
  expect(state.started.length, 'never more engines than changes').toBeLessThanOrEqual(21)
  // an engine is only ever started when the one before it was on the other choice
  expect(state.started.every((on, i) => i === 0 || on !== state.started[i - 1])).toBe(true)
})

it('waits while a page saves a file, and gives up the change if it is taken back meanwhile', async () => {
  const { state, follow } = page()
  state.busy = true
  state.wanted = false
  const done = follow()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(state.started, 'a new engine would have ended the save').toEqual([true])
  state.busy = false
  await done
  expect(state.started).toEqual([true, false])

  state.busy = true
  state.wanted = true
  const again = follow()
  await new Promise((resolve) => setTimeout(resolve, 30))
  state.wanted = false
  await again
  expect(state.started).toEqual([true, false])
})

it('replaces the engine all the same when its resume data cannot be written', async () => {
  const { state, follow } = page({ flush: async () => { throw new Error('flush-resume timed out after 2000ms') } })
  state.wanted = false
  await follow()
  expect(state.started).toEqual([true, false])
})

it('starts no engine when the choice went back while the resume data was written', async () => {
  const restart = vi.fn()
  const state = { wanted: false }
  const follow = vpnFollower({
    wanted: () => state.wanted,
    running: () => true,
    busy: async () => false,
    flush: async () => { state.wanted = true },
    restart,
  })
  await follow()
  expect(restart).toHaveBeenCalledTimes(0)
})

it('waits for a restart that takes its time, and starts the engine on the choice of that moment', async () => {
  const { state, follow } = page({
    restart: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      state.started.push(state.wanted)
    },
  })
  state.wanted = false
  const done = follow()
  await new Promise((resolve) => setTimeout(resolve, 5))
  state.wanted = true
  await done
  expect(state.started, 'one engine, started on the choice as it was when the old one was let go').toEqual([true, true])
})
