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
    /*
     * CLONED FOR REAL, because the worker is reached by `postMessage` and that is what it does.
     *
     * A fake that merely kept the object could not see the failure this guards: the handles for a
     * pick that cannot be re-opened are wrappers around a `File`, and a wrapper carries its methods
     * as own properties so `structuredClone` refuses it. The post then throws, the torrent is
     * already published, and what the person sees is one that never reaches a single per cent with
     * nothing reporting a fault. Measured against the real engine before this line existed.
     */
    createSource: (torrent: unknown) => { sources.push(structuredClone(torrent)) },
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

/**
 * A directory handle shaped like the one `@banou/ponyfill` hands back where an engine has no picker.
 *
 * Its methods are OWN properties, which is not a style choice: that is what makes `structuredClone`
 * refuse it, and refusing is how ripple learns this pick cannot be re-opened and its bytes have to be
 * copied. A prototype here would clone silently and every test below would take the other branch.
 *
 * Built by hand rather than driven out of the real ponyfill because these cases need `File` objects
 * with a stalled `stream()`, which no real picker can produce. That the ponyfill's actual wrapper is
 * walkable is pinned separately, in tests/torrent/walk-ponyfill-pick.test.ts.
 */
const wrappedDirectory = (name: string, files: File[]): FileSystemDirectoryHandle => {
  const entries = files.map((file) => [file.name, {
    kind: 'file',
    name: file.name,
    getFile: async () => file,
    isSameEntry: async () => false,
  }] as [string, unknown])
  return {
    kind: 'directory',
    name,
    entries: async function * () { for (const entry of entries) yield entry },
    values: async function * () { for (const [, handle] of entries) yield handle },
    isSameEntry: async () => false,
  } as unknown as FileSystemDirectoryHandle
}

/**
 * And the control: a handle shaped like a NATIVE one, which is the only difference that matters.
 *
 * Its methods live on a prototype, so `structuredClone` copies it happily, exactly as a real
 * `FileSystemDirectoryHandle` does. That is the whole of what ripple asks a pick, so a stand-in that
 * answers the same way exercises the same branch.
 */
class NativeLikeDirectory {
  kind = 'directory' as const
  constructor (public name: string, private files: File[]) {}
  async * entries () { for (const file of this.files) yield [file.name, new NativeLikeFile(file)] }
  async * values () { for (const file of this.files) yield new NativeLikeFile(file) }
  async isSameEntry () { return false }
}

class NativeLikeFile {
  kind = 'file' as const
  constructor (private file: File) {}
  get name () { return this.file.name }
  async getFile () { return this.file }
  async isSameEntry () { return false }
}

/** Pick that folder, through the same call the dialog's button makes. */
const pickWrapped = async (api: () => UseCreateTorrent, name: string, files: File[]) => {
  ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker =
    async () => wrappedDirectory(name, files)
  await api().pickFolder()
}

const pickNative = async (api: () => UseCreateTorrent, name: string, files: File[]) => {
  ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker =
    async () => new NativeLikeDirectory(name, files)
  await api().pickFolder()
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

    await pickWrapped(api, 'Slice Pack', [
      pick('a.mkv', new Uint8Array(40_001).fill(0x11)),
      pick('b.mkv', new Uint8Array(40_002).fill(0x22)),
    ])
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

    /*
     * A REAL `File`, because this is the one case that reaches `createSource`.
     *
     * The copy is declined here, so the bytes cross to the worker as the files themselves, and the
     * fake above is not one: its `slice` and `stream` are own properties, which is exactly what
     * makes something refuse to clone. Using it would fail the post for a reason that has nothing to
     * do with the handles under test.
     */
    const real = new File([new Uint8Array(30_001).fill(0x11)], long, { lastModified: 1_700_000_000_000 })
    await pickWrapped(api, 'Long Pack', [real])
    await expect.poll(() => api().state.stage).toBe('ready')
    await expect.poll(() => api().state.room?.kind).toBe('unsafe')

    await api().publish(options('Long Pack'))
    await settle(api)

    expect(api().state.room).toEqual({ kind: 'unsafe', element: long })
    expect(adds).toEqual([])
    expect(reserved).toEqual([])
    expect(sources.length).toBe(1)
    /*
     * AND IT SAYS SO, which is what keeps this entry visible after a reload.
     *
     * No copy was made and no handle could be stored, so nothing can re-open this source. The worker
     * writes `started: false` for that, which gives it a ghost row somebody can remove. Without the
     * flag the entry renders in no list at all: not live, not starting, not a ghost, not waiting.
     */
    expect(sources[0]).toMatchObject({ reopenable: false })
    /*
     * AND WHAT IS IN `handles`, which is the half `reopenable` does not prove.
     *
     * The worker reads this torrent's bytes through these, by file index. A wrapped handle cannot
     * cross the post at all, so the page resolves each one to the `File` behind it; posting the
     * wrappers instead throws inside `postMessage` and the torrent never reaches a single per cent.
     * Without this assertion `out.handles.map(() => null)` would satisfy every other line here.
     */
    const posted = sources[0] as { handles: unknown[] }
    expect(posted.handles).toHaveLength(1)
    expect(posted.handles[0], 'the worker was handed no bytes to read').toBeInstanceOf(File)
    expect((posted.handles[0] as File).size).toBe(30_001)
  })

  /**
   * The control, and the branch that did not exist before: a pick that CAN be re-opened.
   *
   * Nothing is measured, nothing is copied, the handle is stored, and the entry is an ordinary
   * running source. A `reopenable` that were hard-coded either way would fail here or above.
   */
  it('stores the handle for a pick that can be re-opened, and copies nothing', async () => {
    const { client, adds, sources, reserved } = fakeClient()
    const api = await mount(client)

    /*
     * A REAL `File`, not the fake above, and the difference is the whole point.
     *
     * `pick()` builds an object whose `slice` and `stream` are own properties, which is exactly what
     * makes a wrapped handle refuse to clone. A control for the cloneable branch therefore cannot
     * use one: the handle would be uncloneable for a reason that has nothing to do with the handle.
     */
    const real = new File([new Uint8Array(20_001).fill(0x33)], 'a.mkv', { lastModified: 1_700_000_000_000 })
    await pickNative(api, 'Kept Pack', [real])
    await expect.poll(() => api().state.stage).toBe('ready')
    expect(api().state.reopenable, 'a handle that clones is one the browser can keep').toBe(true)
    // the room question is never asked, because nothing is going to be copied
    expect(api().state.room).toBeNull()

    await api().publish(options('Kept Pack'))
    await settle(api)

    expect(adds).toEqual([])
    expect(reserved).toEqual([])
    expect(sources.length).toBe(1)
    expect(sources[0]).toMatchObject({ reopenable: true })
    /*
     * And the control for the conversion above: a handle that clones goes over UNTOUCHED.
     *
     * Turning every pick into a `File` would work and would quietly throw away what a native handle
     * is for, which is a fresh read per chunk rather than one snapshot taken at pick time.
     */
    const posted = sources[0] as { handles: unknown[] }
    expect(posted.handles[0], 'a native handle was flattened into a snapshot').not.toBeInstanceOf(File)
  })

  it('goes back to where it started when the copy is cancelled', async () => {
    const { client, adds, reserved } = fakeClient()
    const api = await mount(client)

    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stalled = new Uint8Array(50_002).fill(0x22)

    await pickWrapped(api, 'Cancel Pack', [
      pick('a.mkv', new Uint8Array(50_001).fill(0x11)),
      pick('b.mkv', stalled, {
        stream: () => new ReadableStream({
          async start (controller) {
            await gate
            controller.enqueue(stalled)
            controller.close()
          },
        }),
      }),
      pick('c.mkv', new Uint8Array(50_003).fill(0x33)),
    ])
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
