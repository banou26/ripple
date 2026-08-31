/*
 * A handle is a counter inside one libtorrent session, not a name for a torrent. `id_for_hash` hands
 * out `next_handle_id++` the first time a session meets an info hash, so what a number maps to is
 * decided by the order that session happened to meet its torrents in, and the restore loop skips
 * entries whose `started` is false. Remove one torrent and every id after it shifts by one in the
 * next engine.
 *
 * So a command carrying a handle must reach the engine that minted it or no engine at all. Delivering
 * it to the successor is not a stale no-op, it is an action on a DIFFERENT TORRENT, and `remove`
 * carries `deleteFiles`.
 *
 * These run in a browser project because the client registers window listeners as it is built.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { Transport, TransportHost } from './engine-protocol'

import { createTorrentClient } from './client'
import { ENGINE_RESET } from './engine-protocol'

type Rig = {
  client: ReturnType<typeof createTorrentClient>
  posted: any[]
  /** the engine speaks: everything the client hears arrives through this */
  say: (msg: any) => void
  /** a fresh engine takes over, exactly as a promoted tab's transport swap does */
  swap: () => void
}

const rigs: Rig[] = []

const makeRig = (): Rig => {
  const posted: any[] = []
  let host: TransportHost
  const factory = (h: TransportHost): Transport => {
    host = h
    return { post: (msg: any) => { posted.push(msg) }, destroy: () => {}, pending: () => [] }
  }
  const client = createTorrentClient()
  client.useTransport(factory, true)
  const rig: Rig = {
    client,
    posted,
    say: (msg) => host.message(msg),
    swap: () => client.useTransport(factory, true),
  }
  rigs.push(rig)
  return rig
}

/** the engine is up and has named its torrents, which is every ordinary moment in the app */
const running = (rig: Rig) => {
  rig.say({ type: 'ready' })
  rig.say({ type: 'list', list: [] })
  rig.posted.length = 0
}

const types = (rig: Rig) => rig.posted.map((m) => m?.type)

afterEach(() => {
  for (const rig of rigs) rig.client.destroy()
  rigs.length = 0
})

describe('a command caught by an engine handover', () => {
  it('delivers a handle command while one engine runs the whole time', async () => {
    const rig = makeRig()
    running(rig)

    rig.client.remove(7, true)
    await Promise.resolve()

    expect(types(rig), 'the ordinary path must not be affected by any of this').toContain('remove')
  })

  it('drops a handle command written for the engine that was replaced under it', async () => {
    const rig = makeRig()
    // never started, so the command parks in the gate rather than going out at once
    rig.client.remove(7, true)
    rig.swap()
    running(rig)
    await Promise.resolve()
    await Promise.resolve()

    expect(types(rig), 'a remove aimed at a dead session reached its successor').not.toContain('remove')
  })

  it('drops a handle command minted from rows the page had not repainted yet', async () => {
    const rig = makeRig()
    running(rig)

    /*
     * The window this is about. `use-torrents` clears only the error flags on a reset, so the rows
     * keep rendering with the dead engine's handles and live buttons for as long as the next engine
     * takes to open a session and restore the library. A click here is issued AFTER the generation
     * has already moved on, so the epoch alone cannot tell it apart from a legitimate one.
     */
    rig.say({ type: ENGINE_RESET })
    rig.client.remove(7, true)
    rig.say({ type: 'ready' })
    await Promise.resolve()
    await Promise.resolve()

    expect(types(rig), 'a handle read off a stale row reached the new session').not.toContain('remove')
  })

  it('still delivers it once the new engine has named its torrents', async () => {
    const rig = makeRig()
    running(rig)
    rig.say({ type: ENGINE_RESET })
    rig.say({ type: 'ready' })
    rig.say({ type: 'list', list: [] })
    rig.posted.length = 0

    rig.client.remove(7, true)
    await Promise.resolve()

    expect(types(rig), 'the guard outlived the handover and broke the app').toContain('remove')
  })

  it('fails a read it drops rather than leaving its caller parked', async () => {
    const rig = makeRig()
    running(rig)
    rig.say({ type: ENGINE_RESET })

    // a read is the one command somebody awaits, so a silent drop parks that caller for 120 seconds
    const read = rig.client.read(7, 0, 0, 16)
    rig.say({ type: 'ready' })

    await expect(read).rejects.toThrow(/engine was replaced/)
    expect(types(rig)).not.toContain('read')
  })

  it('carries a command that names its torrent by info hash across the same handover', async () => {
    const rig = makeRig()
    // exactly the case gate.ts exists for: /embed issues this during its own election
    rig.client.addMagnet('magnet:?xt=urn:btih:0000000000000000000000000000000000000000')
    rig.swap()
    running(rig)
    await Promise.resolve()
    await Promise.resolve()

    expect(types(rig), 'dropping this is the bug gate.ts was written to fix').toContain('add-magnet')
  })
})
