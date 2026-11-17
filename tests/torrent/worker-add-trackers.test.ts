import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * Trackers added to a running torrent are answered with the ones the engine refused, shown in the panel's list
 * on the next state rather than at its next 5 s poll, and written into the torrent's resume data even when a
 * save asked before them is still under way.
 */

const FILM = 'a'.repeat(40)

const engine = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  /** what the engine was asked, in order */
  log: [] as string[],
  /** each save the engine was asked for and has not answered yet, oldest first */
  asked: [] as ((blob: Uint8Array) => void)[],
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession, DOWNLOADING } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      status: () => DOWNLOADING,
      addTrackers: (handle: number, urls: string[]) => {
        engine.log.push(`add ${handle} ${urls.join(' ')}`)
        return urls.filter((url) => !url.includes('://'))
      },
      trackers: () => { engine.log.push('trackers'); return [] },
      saveResumeData: () => new Promise<Uint8Array>((resolve) => {
        engine.log.push('save')
        engine.asked.push(resolve)
      }),
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const { store } = engine
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('answers with the refused urls, lists the rest at once, and saves them once a save under way has landed', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${FILM}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  rig.send({ type: 'inspect', handle: 1 })
  await vi.waitFor(() => expect(engine.log).toContain('trackers'))

  // a save the engine has not answered yet, as a flag change asks for
  rig.send({ type: 'set-flags', handle: 1, flags: 0, mask: 0 })
  await vi.waitFor(() => expect(engine.asked).toHaveLength(1))
  engine.log.length = 0

  rig.send({ type: 'add-trackers', id: 4, handle: 1, urls: ['wss://tracker.invalid', 'not a tracker'] })
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 4, value: ['not a tracker'] }]))
  expect(engine.log[0]).toBe('add 1 wss://tracker.invalid not a tracker')
  // asked again on a state or two, well inside the 5 s between polls
  await vi.waitFor(() => expect(engine.log).toContain('trackers'), { timeout: 1_500 })
  expect(engine.log, 'a second save was stacked on the first').not.toContain('save')

  engine.asked[0]!(new Uint8Array([1]))
  await vi.waitFor(() => expect(engine.log, 'the torrent was not saved again once the save under way landed').toContain('save'))
  engine.asked[1]!(new Uint8Array([2]))
  await vi.waitFor(() => expect(engine.store.get('ripple:resume:' + FILM)).toEqual(new Uint8Array([2])))
  expect(rig.of('error')).toEqual([])
})
