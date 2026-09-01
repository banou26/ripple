import type { DownloadTorrent } from '../../src/torrent/use-download-torrent'
import type { SaveEntry } from '../../src/torrent/save-file'

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

/** Every file index the page has asked the engine to fetch, in order. Empty means nothing is moving. */
const claimed: number[] = []
/** Every plan the page has sent the engine, which is what decides what the swarm is asked for. */
const planned: { wanted?: number[], firstLast?: boolean }[] = []
/** How many times the page has handed its claim back, which is what stops the fetching. */
const released = { count: 0 }

/**
 * What the library holds for this torrent.
 *
 * `ephemeral` is the one field that changes behaviour: it says this row is the page's own cache
 * entry rather than a torrent the person keeps, and only then may the page write a plan onto it.
 */
const listed = {
  current: [{ infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', ephemeral: true, firstLast: false }],
}

const torrent = (over: Partial<DownloadTorrent> = {}): DownloadTorrent => ({
  /*
   * The page subscribes to engine resets, to stop an export holding a handle the reset invalidated,
   * and to state, because the card draws a frame of the release where the file glyph used to be and
   * thumbnail generation watches the engine for the bytes to make one from.
   *
   * `onState` never fires here: with no snapshot arriving there is nothing to make a picture out of,
   * so these tests see the glyph, which is what they were written against.
   */
  client: {
    onEngineReset: () => () => {},
    onState: () => () => {},
    // latched in the real client, so a page that subscribes late is still answered
    onList: (cb: (list: unknown[]) => void) => { cb(listed.current); return () => {} },
    setPlan: (_handle: number, plan: { wanted?: number[], firstLast?: boolean }) => { planned.push(plan) },
  } as unknown as DownloadTorrent['client'],
  claim: (fileIndex: number) => { claimed.push(fileIndex) },
  release: () => { released.count++ },
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
vi.mock('../../src/torrent/use-download-torrent', () => ({ useDownloadTorrent: () => state.current }))

const saved = {
  zip: [] as { name: string, entries: SaveEntry[], viewer?: string }[],
  file: [] as { index: number, path: string, size: number, viewer?: string }[],
  /**
   * Leave the export RUNNING instead of resolving it, so a test can act while a job is in flight.
   *
   * Everything else in this file wants a save that has already finished, which is why the default
   * is to resolve on the spot.
   */
  holds: false,
  settle: null as null | { resolve: () => void, reject: (error: unknown) => void },
}

const held = () => (saved.holds
  ? new Promise<void>((resolve, reject) => { saved.settle = { resolve, reject } })
  : Promise.resolve())
vi.mock('../../src/torrent/save-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/save-file')>()),
  saveTorrentEntriesAsZipToDisk: async (
    _client: unknown, _handle: number, name: string, entries: SaveEntry[],
    _onProgress?: unknown, options?: { viewer?: string },
  ) => { saved.zip.push({ name, entries, viewer: options?.viewer }); return held() },
  saveTorrentFileToDisk: async (
    _client: unknown, _handle: number, index: number, path: string, size: number,
    _onProgress?: unknown, options?: { viewer?: string },
  ) => { saved.file.push({ index, path, size, viewer: options?.viewer }); return held() },
}))

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 900px; height: 700px;'
  document.body.append(container)
  return { container }
}

/**
 * base64 of `magnet:?xt=urn:btih:abc&dn=Pack.Name`, which is the legacy link form README publishes.
 *
 * It carries an infohash on purpose: without one the page cannot find its own entry in the library,
 * and everything that depends on knowing whose torrent this is silently does nothing.
 */
const MAGNET = 'bWFnbmV0Oj94dD11cm46YnRpaDphYmMmZG49UGFjay5OYW1l'

const mount = async (search: string) => {
  const { default: Embed } = await import('../../src/router/embed')
  return render(
    <MemoryRouter initialEntries={[`/embed?magnet=${MAGNET}${search}`]}>
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
    saved.holds = false
    saved.settle = null
    claimed.length = 0
    planned.length = 0
    released.count = 0
    listed.current = [{ infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', ephemeral: true, firstLast: false }]
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

    // no click to open it: the list holds the choice this page is asking for, so it arrives open
    // every row announces its own file, so the list is not read as N identical buttons
    const rows = [...screen.container.querySelectorAll('.files .file button')]
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Download E01.mkv', 'Download E02.mkv', 'Download E03.mkv', 'Download notes.txt',
    ])
    // which also means a row can be addressed by NAME here rather than by position
    await screen.getByRole('button', { name: 'Download E03.mkv', exact: true }).click()

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

  /**
   * Arriving must cost nothing, which is the whole reason the page has a button.
   *
   * It used to claim a viewer the moment the file list landed, so opening a link started pulling
   * the first file of the selection at full speed into a browser's storage before anybody had
   * agreed to download anything, and the only sign of it was a peer count.
   */
  it('asks the engine for nothing until Download is pressed', async () => {
    const screen = await mount('&mode=download&files=2')
    await expect.element(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
    // a rendered file list proves the metadata arrived, so this is the held state and not a page still loading
    await expect.element(screen.getByText('E03.mkv')).toBeInTheDocument()
    expect(claimed).toEqual([])
    // a swarm readout under an unpressed button would be describing a transfer that must not exist
    expect(screen.container.querySelector('[data-testid="swarm"]')).toBeNull()

    await screen.getByRole('button', { name: 'Download' }).click()

    // the ENGINE index of the chosen file, not its position in the selection
    expect(claimed).toEqual([2])
  })

  it('claims the first file of a zip, which is where the archive starts writing', async () => {
    const screen = await mount('&mode=download&files=1-2')
    await screen.getByRole('button', { name: /Download 2 files as .zip/ }).click()
    expect(claimed).toEqual([1])
  })

  /**
   * Choosing what to take.
   *
   * The link decides what is on the table and the person decides what comes off it, which are two
   * different sets: `offered` and `entries` in the page. Nearly every check here is written against
   * the ENGINE's file indices rather than what is on screen, because that is the one mistake this
   * whole area makes silently, handing somebody an archive of the right names holding the wrong
   * episodes.
   */
  it('takes the files that are ticked and leaves out the ones that are not', async () => {
    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: /Download 4 files/ })).toBeInTheDocument()

    // addressed by NAME, so a row moving cannot make this tick something other than it meant to
    await screen.getByRole('checkbox', { name: 'E02.mkv' }).click()
    await screen.getByRole('checkbox', { name: 'notes.txt' }).click()

    // 1.4 GB + 1.6 GB: the size follows the ticks, not the link
    await expect.element(screen.getByText('3 GB · 2 files')).toBeInTheDocument()
    await screen.getByRole('button', { name: /Download 2 files as \.zip/ }).click()

    expect(saved.zip[0]!.entries.map((e) => e.index)).toEqual([0, 2])
  })

  /**
   * The regression this page has already had once, now reachable from a checkbox.
   *
   * `1-3` is E02, E03 and notes.txt, so unticking E03 leaves engine indices 1 and 3 while its
   * POSITION in the list on screen is 1. Anything that ticks by position exports E02 and E03.
   */
  it('ticks in engine indices, not in positions in the list on screen', async () => {
    const screen = await mount('&mode=download&files=1-3')
    await screen.getByRole('checkbox', { name: 'E03.mkv' }).click()
    await screen.getByRole('button', { name: /Download 2 files as \.zip/ }).click()

    expect(saved.zip[0]!.entries.map((e) => e.index)).toEqual([1, 3])
  })

  it('hands over one ticked file directly rather than as a zip of one', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Select none' }).click()
    await screen.getByRole('checkbox', { name: 'E03.mkv' }).click()

    await screen.getByRole('button', { name: 'Download', exact: true }).click()

    expect(saved.zip).toEqual([])
    expect(saved.file.map((f) => f.index)).toEqual([2])
  })

  /**
   * An empty selection is refused rather than treated as "everything".
   *
   * libtorrent accepts a torrent with every file skipped perfectly happily and then sits at 0 per
   * cent looking like a stalled download, so the page never sends one. The row buttons stay live
   * through it, because a row is its own action and Select none must not leave a page with nothing
   * on it that does anything.
   */
  it('refuses an empty selection, and still lets a single row be taken', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Select none' }).click()

    await expect.element(screen.getByRole('button', { name: 'Select at least one file' })).toBeDisabled()
    await expect.element(screen.getByText('Nothing selected')).toBeInTheDocument()

    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()
    expect(saved.file.map((f) => f.index)).toEqual([0])
    expect(planned.map((plan) => plan.wanted), 'an empty plan stops the torrent dead').toEqual([[0]])
  })

  /**
   * The whole point of taking one file first: the rest are still there afterwards.
   *
   * The export resolves immediately in this file, so everything after the first click is the state
   * a finished download leaves behind. It used to be a state the page could not leave: the claim it
   * made was never handed back, so the engine kept that one file at normal priority and every other
   * at skip for as long as the tab was open.
   */
  it('lets the rest of the pack be taken after one file has been', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()

    await expect.element(screen.getByRole('button', { name: 'Download E03.mkv', exact: true })).toBeEnabled()
    await screen.getByRole('button', { name: 'Download E03.mkv', exact: true }).click()

    expect(saved.file.map((f) => f.index)).toEqual([0, 2])
    // and the engine was pointed at each in turn, rather than left anchored on the first
    expect(claimed).toEqual([0, 2])
  })

  it('says which files have already landed, so somebody coming back knows what is left', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()

    await expect
      .poll(() => [...screen.container.querySelectorAll('.files .file')]
        .filter((row) => row.querySelector('.mark.saved'))
        .map((row) => row.querySelector('.name')!.textContent))
      .toEqual(['E01.mkv'])
  })

  /**
   * What the SWARM is asked for, which is the half of a selection that is not on screen.
   *
   * The plan is what the engine writes over the whole torrent whenever nothing is claiming bytes,
   * so it is what "only these files" means once the reading stops. It is sent before the claim, and
   * again when the job ends, because the ticks can move while one runs.
   */
  it('tells the engine which files to want, in engine indices', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('checkbox', { name: 'E02.mkv' }).click()
    await screen.getByRole('button', { name: /Download 3 files as \.zip/ }).click()

    expect(planned[0]).toEqual({ wanted: [0, 2, 3], firstLast: false })
  })

  it('says "all of it" by leaving the list out, rather than by naming every index', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: /Download 4 files/ }).click()

    // absent is what survives a torrent gaining a file it did not have when this was decided
    expect(planned[0]).toEqual({ wanted: undefined, firstLast: false })
  })

  /**
   * The plan that MATTERS is the one sent when the job ends, and it follows the ticks as they move.
   *
   * A download is the only time the ticks and the engine can drift: the plan sent at the start names
   * what that job needs, and somebody carries on choosing while it runs. What the torrent is left
   * wanting has to be what is ticked when the reading stops, not what was ticked when it started,
   * and reading only `planned[0]` would never have noticed the difference.
   */
  it('plans what is ticked when a job ENDS, not what was ticked when it began', async () => {
    saved.holds = true
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()

    await expect.poll(() => planned.length).toBe(1)
    // everything is still ticked, and this row is one of them, so the plan says "all of it"
    expect(planned[0]).toEqual({ wanted: undefined, firstLast: false })

    await screen.getByRole('checkbox', { name: 'E02.mkv' }).click()
    await screen.getByRole('checkbox', { name: 'notes.txt' }).click()

    saved.settle!.resolve()
    await expect.poll(() => planned.length).toBe(2)
    expect(planned[1], 'the torrent was left wanting the selection the job started with')
      .toEqual({ wanted: [0, 2], firstLast: false })
  })

  /**
   * An embed on somebody else's site must not narrow a torrent the person keeps.
   *
   * A plan rewrites that torrent's file selection and clears its first-and-last flag, nothing in
   * the app shows either, and nothing offers a way to put them back. The positive control is in the
   * same test on purpose: this has to be a page that plans nothing, not a page that does nothing.
   */
  it('never plans a torrent the person has in their own library', async () => {
    listed.current = [{ infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', ephemeral: false, firstLast: true }]
    const screen = await mount('&mode=download')
    await screen.getByRole('checkbox', { name: 'E02.mkv' }).click()
    await screen.getByRole('button', { name: /Download 3 files as \.zip/ }).click()

    expect(planned, 'an embed narrowed a torrent that is not its own').toEqual([])
    expect(saved.zip, 'the export must still happen').toHaveLength(1)
  })

  /**
   * The claim is given back when the job ends, which is what stops the fetching.
   *
   * Without it a cancelled download carries on into browser storage until the tab is closed: the
   * button says stopped and the engine, which was never told, does not.
   */
  it('hands the claim back when a download ends', async () => {
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()

    await expect.poll(() => released.count).toBe(1)
  })

  /**
   * Pad files are not the person's data and belong in nothing they see.
   *
   * They are zeroes a v2 or hybrid torrent inserts to push the next file onto a piece boundary. The
   * page reads the ENGINE's list, which has to keep them so that `files[i]` is still file i, so
   * every list drawn from it has to drop them by hand. Ticking one, or zipping one, would put a
   * folder of zeroes in somebody's archive under a name they have never seen.
   */
  it('never offers a pad file, and still names the real ones by their engine index', async () => {
    const base = torrent()
    state.current = torrent({
      snapshot: {
        ...base.snapshot!,
        files: {
          ...base.snapshot!.files!,
          files: [
            { path: 'Pack.Name/E01.mkv', size: 1_400_000_000, offset: 0, pad: false },
            { path: 'Pack.Name/.pad/262144', size: 262_144, offset: 1_400_000_000, pad: true },
            { path: 'Pack.Name/E02.mkv', size: 1_500_000_000, offset: 1_400_262_144, pad: false },
          ],
        },
      },
    } as never)

    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: /Download 2 files as \.zip/ })).toBeInTheDocument()
    expect([...screen.container.querySelectorAll('.files .file .name')].map((n) => n.textContent))
      .toEqual(['E01.mkv', 'E02.mkv'])

    await screen.getByRole('button', { name: /Download 2 files as \.zip/ }).click()
    // 2, not 1: the second real file is at engine index 2 with the pad sitting between them
    expect(saved.zip[0]!.entries.map((e) => e.index)).toEqual([0, 2])
  })

  /**
   * Nothing is claimed back for a page that no longer exists.
   *
   * An export is aborted on unmount and its promise settles a turn later, after the hook has already
   * handed every claim back. A hold registered at that point recreates a viewer nothing will ever
   * remove, and a torrent with a viewer is one the storage budget may not reclaim, so what leaks is
   * a torrent that can never be evicted rather than a stray message.
   */
  it('registers no claim once the page has gone away', async () => {
    saved.holds = true
    const screen = await mount('&mode=download')
    await screen.getByRole('button', { name: 'Download E01.mkv', exact: true }).click()
    await expect.poll(() => saved.file.length, { timeout: 5_000 }).toBe(1)

    screen.unmount()
    saved.settle!.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    // a turn for the rejection to reach the .finally, which is where the claim would be made
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(released.count, 'a claim was handed back for a page that is gone').toBe(0)
  })

  it('claims the row that was pressed, not the head of the page selection', async () => {
    const screen = await mount('&mode=download')
    await expect.element(screen.getByRole('button', { name: /Download 4 files/ })).toBeInTheDocument()
    await screen.getByRole('button', { name: 'Download E03.mkv', exact: true }).click()
    expect(claimed).toEqual([2])
  })
})

/**
 * The way OUT of the download page, for a link whose torrent turns out to be watchable.
 *
 * Somebody handed a download link may not know Ripple can play it in the same tab, and the page had
 * no way of telling them. Offered only once the ENGINE has said there is something to play, because
 * the link itself says nothing about the files: a link that claimed a video would be a link choosing
 * what the page offers.
 */
describe('offering to watch instead', () => {
  beforeEach(() => { state.current = torrent() })

  it('offers Watch when the requested files include a video', async () => {
    const screen = await mount('&mode=download')
    const watch = screen.container.querySelector('a.watch') as HTMLAnchorElement
    expect(watch, 'no Watch link was offered for a pack of mkv files').toBeTruthy()
    expect(watch.getAttribute('href')).toContain('mode=watch')
  })

  /**
   * The LARGEST video, addressed by its ENGINE index rather than its position in the list on screen.
   *
   * `files=1-3` is what makes this a real check: it selects E02, E03 and notes.txt, so the biggest
   * video is E03, at engine index 2 but position 1. Code that passed the position would send
   * `fileIndex=1` and play the wrong episode, and every number would still look plausible. Without
   * the selection the two coincide and the test would pass either way.
   */
  it('opens the largest video, by the torrent index and not the position on screen', async () => {
    const screen = await mount('&mode=download&files=1-3')
    const href = (screen.container.querySelector('a.watch') as HTMLAnchorElement).getAttribute('href')!
    expect(href).toContain('fileIndex=2')
    expect(href, 'the position was used instead of the engine index').not.toContain('fileIndex=1')
  })

  /** A link naming the subtitles should not offer to play the video it did not ask for. */
  it('asks only about the files the link named', async () => {
    const screen = await mount('&mode=download&files=3')
    expect(screen.container.querySelector('a.watch')).toBeNull()
  })

  it('names the file when there is more than one to choose between', async () => {
    const screen = await mount('&mode=download')
    expect(screen.container.querySelector('a.watch')!.textContent).toContain('E03.mkv')
    const one = await mount('&mode=download&files=0')
    expect(one.container.querySelector('a.watch')!.textContent?.trim()).toBe('Watch')
  })

  /**
   * Nothing to offer before metadata, which is the case the file list used to paper over. The link
   * carries no description of the torrent any more, so the page has nothing to go on until the
   * engine answers, and says so rather than guessing.
   */
  it('offers nothing until the engine has said what is in there', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, files: null } as never })
    const screen = await mount('&mode=download')
    expect(screen.container.querySelector('a.watch')).toBeNull()
    await expect.element(screen.getByText('Reading the torrent from the network')).toBeVisible()
  })
})

