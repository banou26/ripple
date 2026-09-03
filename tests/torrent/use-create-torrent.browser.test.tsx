import type { CreateOptions } from '../../src/torrent/create-source'
import type { TorrentClient } from '../../src/torrent/client'
import type { UseCreateTorrent } from '../../src/torrent/use-create-torrent'

import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'

import { DEFAULT_TRACKERS, useCreateTorrent } from '../../src/torrent/use-create-torrent'
import { readTorrentFile } from '../../src/torrent/torrent-file'

type Add = { options: unknown, lengthAtCall: number }

const fakeClient = () => {
  const adds: Add[] = []
  const sources: unknown[] = []
  const reserved: { infoHash: string, on: boolean }[] = []
  const locations: unknown[] = []
  const client = {
    addTorrentFile: (bytes: Uint8Array, options?: unknown) => {
      adds.push({ options, lengthAtCall: bytes.byteLength })
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
    },
    createSource: (torrent: unknown) => { sources.push(torrent) },
    reserveStorage: (infoHash: string, on: boolean) => { reserved.push({ infoHash, on }) },
    setLocation: (infoHash: string, to: unknown) => { locations.push({ infoHash, to }) },
  } as unknown as TorrentClient
  return { client, adds, sources, reserved, locations }
}

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: since TS 5.7 the default parameter is
// `ArrayBufferLike`, which includes SharedArrayBuffer and is therefore not a `BlobPart`
const pick = (path: string, bytes: Uint8Array<ArrayBuffer>, over: Partial<{ stream: () => ReadableStream }> = {}) => {
  const blob = new Blob([bytes])
  return {
    name: path.split('/').pop()!,
    webkitRelativePath: path,
    size: blob.size,
    lastModified: 1_700_000_000_000,
    slice: (start?: number, end?: number) => blob.slice(start, end),
    stream: () => blob.stream(),
    ...over,
  } as unknown as File
}

/**
 * The publish path for a pick that cannot be re-opened, driven in a REAL browser against a fake
 * engine, because five separate faults in it are invisible to every other kind of test.
 *
 * A Playwright spec proves the torrent seeds and survives a reload, which is the outcome. It cannot
 * see any of these, because each is about what the page does on the way there:
 *
 *  - the bytes handed to `addTorrentFile` are TRANSFERRED, so passing `out.bytes` rather than a copy
 *    detaches the page's own view to zero length, silently, with nothing throwing. `fakeClient` here
 *    performs the transfer for real, with `structuredClone(buffer, { transfer: [buffer] })`, so the
 *    detaching is not simulated.
 *  - `saveTo` has to travel WITH the add. A `setLocation` sent after it runs FIRST, because
 *    add-torrent-file is unqueued and polls up to ten seconds for the infohash, and then finds no
 *    entry to patch. `locations` being empty is the assertion for that.
 *  - the save directory has to be RESERVED against the orphan sweep before the first byte, and
 *    released again on the failure path only.
 *  - a name the engine would rename has to decline the copy and fall back to sharing from the pick.
 *  - cancelling mid-copy has to land back at `idle`, not on a red error, which needs `AbortError` to
 *    be one of the cancellation shapes `fail()` knows.
 *
 * Every one of the five was proven by reverting its fix and watching exactly these tests go red.
 *
 * A real browser rather than the node project because the copy writes to OPFS through
 * `createWritable`, and because `File.stream()` and a transferable ArrayBuffer are the two things the
 * hazards are actually made of.
 */

const options = (name: string): CreateOptions =>
  ({ name, trackers: [...DEFAULT_TRACKERS], private: false, format: 'v1' })

const SETTLED = ['done', 'error', 'idle']

/**
 * Wait for the flow to stop moving, then insist it stopped on `done`.
 *
 * Polling straight for `done` would sit there for the whole timeout on any failure and report a
 * matcher that ran out of time, saying nothing about what went wrong. Waiting for any resting state
 * and then reading `error` puts the reason in the failure message.
 */
const settle = async (api: () => UseCreateTorrent) => {
  await expect.poll(() => SETTLED.includes(api().state.stage), { timeout: 10_000 }).toBe(true)
  expect(api().state.error).toBeNull()
  expect(api().state.stage).toBe('done')
}

const mount = async (client: TorrentClient) => {
  const held = { current: null as UseCreateTorrent | null }
  const Harness = () => {
    held.current = useCreateTorrent(client)
    return <div/>
  }
  render(<Harness/>)
  await expect.poll(() => held.current).not.toBeNull()
  return () => held.current!
}

describe('publishing a pick that cannot be re-opened', () => {
  it('keeps its own bytes readable after the add, and tells the add where they went', async () => {
    const { client, adds, sources, reserved, locations } = fakeClient()
    const api = await mount(client)

    api().pickFiles([
      pick('Slice Pack/a.mkv', new Uint8Array(40_001).fill(0x11)),
      pick('Slice Pack/b.mkv', new Uint8Array(40_002).fill(0x22)),
    ], true)
    await expect.poll(() => api().state.stage).toBe('ready')
    await expect.poll(() => api().state.room?.kind).toBe('fits')

    await api().publish(options('Slice Pack'))
    await settle(api)

    const built = api().state.built!
    expect(adds.length).toBe(1)
    expect(adds[0]!.options).toEqual({ savePath: `/dl/${built.infoHash}`, saveTo: 'browser', created: true })
    expect(locations).toEqual([])
    expect(sources).toEqual([])
    expect(reserved).toEqual([{ infoHash: built.infoHash, on: true }])

    expect(built.bytes.byteLength).toBe(adds[0]!.lengthAtCall)
    const readBack = await readTorrentFile(built.bytes)
    expect(readBack?.magnet).toContain(built.infoHash)
    expect(readBack?.files?.map((file) => file.name)).toEqual(['Slice Pack/a.mkv', 'Slice Pack/b.mkv'])
  })

  it('declines the copy for a name the engine would rename, and shares from the pick instead', async () => {
    const { client, adds, sources, reserved } = fakeClient()
    const api = await mount(client)
    const long = 'x'.repeat(237) + '.mkv'

    api().pickFiles([pick(`Long Pack/${long}`, new Uint8Array(30_001).fill(0x11))], true)
    await expect.poll(() => api().state.stage).toBe('ready')
    await expect.poll(() => api().state.room?.kind).toBe('unsafe')

    await api().publish(options('Long Pack'))
    await settle(api)

    expect(api().state.room).toEqual({ kind: 'unsafe', element: long })
    expect(adds).toEqual([])
    expect(reserved).toEqual([])
    expect(sources.length).toBe(1)
  })

  it('goes back to where it started when the copy is cancelled', async () => {
    const { client, adds, reserved } = fakeClient()
    const api = await mount(client)

    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stalled = new Uint8Array(50_002).fill(0x22)

    api().pickFiles([
      pick('Cancel Pack/a.mkv', new Uint8Array(50_001).fill(0x11)),
      pick('Cancel Pack/b.mkv', stalled, {
        stream: () => new ReadableStream({
          async start (controller) {
            await gate
            controller.enqueue(stalled)
            controller.close()
          },
        }),
      }),
      pick('Cancel Pack/c.mkv', new Uint8Array(50_003).fill(0x33)),
    ], true)
    await expect.poll(() => api().state.stage).toBe('ready')
    await expect.poll(() => api().state.room?.kind).toBe('fits')

    const publishing = api().publish(options('Cancel Pack'))
    await expect.poll(() => api().state.copy?.file, { timeout: 20_000 }).toBe(1)
    api().cancel()
    release()
    await publishing

    await expect.poll(() => api().state.stage).toBe('idle')
    expect(api().state.error).toBeNull()
    expect(adds).toEqual([])
    expect(reserved.map((call) => call.on)).toEqual([true, false])
  })
})
