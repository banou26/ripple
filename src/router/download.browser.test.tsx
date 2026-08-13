import type { DownloadTorrent } from '../torrent/use-download-torrent'
import type { SaveEntry } from '../torrent/save-file'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter } from 'react-router-dom'

/**
 * What `mode=download` puts on screen, and what it asks the save path for.
 *
 * The engine and the sink are both mocked: neither belongs in this measurement. What does belong is
 * the translation from a URL to a set of ENGINE file indices, because getting it wrong is silent.
 * `saveTorrentAsZipToDisk` used to read `files.map((f, index) => client.read(handle, index, ...))`,
 * so handing it any subset of a torrent's files exported the first N files under the names of the
 * chosen ones. Nothing throws, the zip opens, and the contents are the wrong episodes.
 */
const FILES = [
  { path: 'Pack.Name/E01.mkv', size: 1_400_000_000, offset: 0 },
  { path: 'Pack.Name/E02.mkv', size: 1_500_000_000, offset: 1_400_000_000 },
  { path: 'Pack.Name/E03.mkv', size: 1_600_000_000, offset: 2_900_000_000 },
  { path: 'Pack.Name/notes.txt', size: 2_048, offset: 4_500_000_000 },
]

const torrent = (over: Partial<DownloadTorrent> = {}): DownloadTorrent => ({
  // the page subscribes to engine resets to stop an export holding a handle the reset invalidated
  client: { onEngineReset: () => () => {} } as unknown as DownloadTorrent['client'],
  snapshot: {
    handle: 7,
    magnet: 'magnet:?xt=urn:btih:abc&dn=Pack.Name',
    files: { storageIndex: 0, pieceLength: 1 << 20, numPieces: 4300, totalSize: 4_500_002_048, files: FILES },
    status: { numPeers: 82, uploadRate: 0 },
    bitfield: null,
    recovery: null,
    userPaused: false,
    displayDownloadRate: 8_700_000,
  },
  handle: 7,
  viewer: 'viewer-1',
  engineError: null,
  storageFull: false,
  ...over,
} as DownloadTorrent)

const state = { current: torrent() }
vi.mock('../torrent/use-download-torrent', () => ({ useDownloadTorrent: () => state.current }))

const saved = {
  zip: [] as { name: string, entries: SaveEntry[], viewer?: string }[],
  file: [] as { index: number, path: string, size: number, viewer?: string }[],
}
vi.mock('../torrent/save-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../torrent/save-file')>()),
  saveTorrentEntriesAsZipToDisk: async (
    _client: unknown, _handle: number, name: string, entries: SaveEntry[],
    _onProgress?: unknown, options?: { viewer?: string },
  ) => { saved.zip.push({ name, entries, viewer: options?.viewer }) },
  saveTorrentFileToDisk: async (
    _client: unknown, _handle: number, index: number, path: string, size: number,
    _onProgress?: unknown, options?: { viewer?: string },
  ) => { saved.file.push({ index, path, size, viewer: options?.viewer }) },
}))

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 900px; height: 700px;'
  document.body.append(container)
  return { container }
}

const mount = async (search: string) => {
  const { default: Embed } = await import('./embed')
  return render(
    <MemoryRouter initialEntries={[`/embed?magnet=bWFnbmV0Og==${search}`]}>
      <Embed />
    </MemoryRouter>,
    sized(),
  )
}

describe('the embed route in download mode', () => {
  beforeEach(() => {
    state.current = torrent()
    saved.zip = []
    saved.file = []
  })

  it('stays the player when no mode is asked for', async () => {
    /**
     * The one shipped consumer passes only `magnet`. If this ever fails, adding the download mode
     * broke playback for it.
     *
     * Only the ELEMENT is asserted, not any of its content: this file mocks the download hook and
     * leaves `usePlayerTorrent` real, so there is no torrent behind the player here and nothing for
     * it to name. That the player mounts at all is the whole claim.
     */
    const screen = await mount('')
    await expect.poll(() => screen.container.querySelector('video')).not.toBeNull()
    expect(screen.container.querySelector('.cta'), 'the download card must not be mounted').toBeNull()
  })

  it('renders a download page instead of a player', async () => {
    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: /Download 4 files/ })).toBeInTheDocument()
    // the player must not be mounted behind it: it would claim its own viewer and read for nothing
    expect(screen.container.querySelector('video')).toBeNull()
  })

  it('names a single file and offers it directly rather than as a zip of one', async () => {
    const screen = await mount('&mode=download&files=2')
    await expect.element(screen.getByText('E03.mkv')).toBeInTheDocument()
    await expect.element(screen.getByText('1.6 GB')).toBeInTheDocument()

    await screen.getByRole('button', { name: 'Download' }).click()

    expect(saved.zip).toEqual([])
    expect(saved.file).toEqual([
      { index: 2, path: 'Pack.Name/E03.mkv', size: 1_600_000_000, viewer: 'viewer-1' },
    ])
  })

  /**
   * The regression this file exists for: a range must export the files it names.
   *
   * `1-2` on this torrent is E02 and E03. Reading by list position would export E01 and E02 under
   * those names, which is a silently wrong archive rather than a failure.
   */
  it('zips a range using the engine file indices, not positions in the filtered list', async () => {
    const screen = await mount('&mode=download&files=1-2')
    await expect.element(screen.getByRole('button', { name: /Download 2 files as .zip/ })).toBeInTheDocument()
    // 1.5 GB + 1.6 GB, so the total describes the SELECTION rather than the torrent
    await expect.element(screen.getByText('3.1 GB · 2 files')).toBeInTheDocument()

    await screen.getByRole('button', { name: /Download 2 files as .zip/ }).click()

    expect(saved.file).toEqual([])
    expect(saved.zip).toHaveLength(1)
    expect(saved.zip[0]!.name).toBe('Pack.Name')
    expect(saved.zip[0]!.entries).toEqual([
      { index: 1, path: 'Pack.Name/E02.mkv', size: 1_500_000_000 },
      { index: 2, path: 'Pack.Name/E03.mkv', size: 1_600_000_000 },
    ])
    // and the export reads as the page's viewer, or the engine plans nothing and it crawls
    expect(saved.zip[0]!.viewer).toBe('viewer-1')
  })

  it('takes a comma list too', async () => {
    const screen = await mount('&mode=download&files=0,3')
    await screen.getByRole('button', { name: /Download 2 files as .zip/ }).click()
    expect(saved.zip[0]!.entries.map((e) => e.index)).toEqual([0, 3])
  })

  it('downloads one file out of a multi-file selection from its own row', async () => {
    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: /Download 4 files/ })).toBeInTheDocument()

    // the <summary> specifically: "4 files" also appears in the size line and on the main button
    ;(screen.container.querySelector('.files summary') as HTMLElement).click()
    await screen.getByRole('button', { name: 'Get' }).nth(2).click()

    expect(saved.file).toEqual([
      { index: 2, path: 'Pack.Name/E03.mkv', size: 1_600_000_000, viewer: 'viewer-1' },
    ])
  })

  it('says so instead of downloading something else when the selection names nothing real', async () => {
    // Widening to the whole torrent here would hand somebody a different release than they asked for
    const screen = await mount('&mode=download&files=9')
    await expect.element(screen.getByText(/None of the requested files/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: 'No matching files' })).toBeDisabled()
  })

  /**
   * `files` is embedder-written text in a URL, and its width is not this app's to assume.
   *
   * Both of these used to take the renderer out before anything rendered: the range was expanded
   * into an array one entry per index (a multi-GB allocation at this width), and the first index of
   * a multi-part list was found with `Math.min(...indices)`, which passes one argument per element
   * and throws RangeError above roughly 100k of them. The second threw inside a `useMemo` during
   * render, so the page did not stall, it never mounted at all.
   *
   * Asserted at the route rather than on the parser, because "the parser returns quickly" is not the
   * claim that matters; "there is a page" is.
   */
  it('survives a range far wider than any real torrent', async () => {
    const screen = await mount('&mode=download&files=0-2000000000')
    // clamped to what the torrent actually has, not to what the URL asked for
    await expect.element(screen.getByRole('button', { name: /Download 4 files/ })).toBeInTheDocument()
  })

  it('survives a huge multi-part list, which used to blow the call stack during render', async () => {
    const screen = await mount('&mode=download&files=900-2000000000,1')
    await expect.element(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    // only file 1 exists out of that selection, so it is delivered as a file rather than a zip
    await expect.element(screen.getByText('E02.mkv')).toBeInTheDocument()
  })

  it('does not let a wide selection reach the player either', async () => {
    // `files` needs no `mode=download` to be parsed: the memo runs above the mode branch
    const screen = await mount('&files=0-2000000000')
    await expect.poll(() => screen.container.querySelector('video')).not.toBeNull()
  })

  it('waits for metadata before offering anything', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, files: null }, handle: null })
    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: 'Loading torrent…' })).toBeDisabled()
  })

  it('reports an engine failure rather than counting peers that will never arrive', async () => {
    state.current = torrent({ engineError: 'The download engine stopped. Reload the page to try again.' })
    const screen = await mount('&mode=download')
    await expect.element(screen.getByText(/The download engine stopped/)).toBeInTheDocument()
    expect(screen.container.querySelector('[data-testid="swarm"]')).toBeNull()
  })
})
