import type { CreateOptions } from '../../src/torrent/create-source'
import type { TorrentClient } from '../../src/torrent/client'
import type { UseCreateTorrent } from '../../src/torrent/use-create-torrent'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * The browser accepts the handle and then refuses to keep it, which is the one case the pick time
 * probe cannot answer.
 *
 * `canBeReopened` asks whether a handle survives `structuredClone`, before any bytes are read, so the
 * dialog can promise the right thing and the copy can be measured in time. That is the same algorithm
 * IndexedDB stores by, so the two agree almost always. Almost: a full origin, a private window that
 * refuses persistence, a store that was cleared mid publish. Then the clone says yes and the write
 * says no, and the entry has no way back to its files.
 *
 * What must happen then is that the LATER answer wins, in both directions at once: the worker is told
 * the source is not re-openable, so the entry becomes a ghost somebody can remove rather than a row
 * that renders nowhere, and the closing line stops promising that the browser will ask for access
 * again after a reload.
 *
 * Its own file because `set` has to be mocked for the whole module graph, and the other create tests
 * need the real one.
 */
vi.mock('idb-keyval', () => ({
  get: async () => undefined,
  del: async () => {},
  set: async () => { throw new DOMException('the store is full', 'QuotaExceededError') },
  update: async () => {},
}))

const { DEFAULT_TRACKERS, useCreateTorrent } = await import('../../src/torrent/use-create-torrent')

const fakeClient = () => {
  const sources: unknown[] = []
  const client = {
    addTorrentFile: () => {},
    createSource: (torrent: unknown) => { sources.push(structuredClone(torrent)) },
    reserveStorage: () => {},
    setLocation: () => {},
  } as unknown as TorrentClient
  return { client, sources }
}

/** Methods on a PROTOTYPE, so it clones exactly as a real handle does and the probe answers yes. */
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

const options = (name: string): CreateOptions =>
  ({ name, trackers: [...DEFAULT_TRACKERS], private: false, format: 'v1' })

describe('a handle the browser clones but will not store', () => {
  it('reports the source as not re-openable, in the message AND on the screen', async () => {
    const { client, sources } = fakeClient()
    const api = await mount(client)

    const real = new File([new Uint8Array(15_001).fill(0x44)], 'a.mkv', { lastModified: 1_700_000_000_000 })
    ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker =
      async () => new NativeLikeDirectory('Refused Pack', [real])
    await api().pickFolder()

    await expect.poll(() => api().state.stage).toBe('ready')
    // the probe said yes, which is what makes this the interesting case rather than an ordinary one
    expect(api().state.reopenable, 'the clone probe should have accepted this handle').toBe(true)

    await api().publish(options('Refused Pack'))
    await expect.poll(() => ['done', 'error', 'idle'].includes(api().state.stage), { timeout: 10_000 }).toBe(true)
    expect(api().state.error, 'a refused store must not fail the publish: the torrent still seeds').toBeNull()
    expect(api().state.stage).toBe('done')

    expect(sources.length).toBe(1)
    expect(
      sources[0],
      'the worker was told this source can be re-opened, so its entry will render in no list at all',
    ).toMatchObject({ reopenable: false })
    expect(
      api().state.reopenable,
      'the screen still promises the browser will ask for access again, for a handle it did not keep',
    ).toBe(false)
  })
})
