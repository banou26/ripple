import type { Torrent } from '../torrent/types'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { EmbedBuilder } from './embed-builder'

/**
 * What the panel puts in the link, which is the only thing about it that can be silently wrong.
 *
 * The two failures worth guarding are both invisible on screen: a watch link carrying a `files` set
 * the player never reads, and an empty selection compiling to an absent `files`, which the embed
 * page reads as EVERY file. Both produce a link that works and delivers the wrong thing.
 */
const file = (name: string, size: number) => ({ name, size, progress: 1 })

const SINTEL: Torrent = {
  id: '7',
  magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10',
  name: 'Sintel',
  size: 129_300_000,
  downloaded: 0,
  progress: 0,
  state: 'downloading',
  down: 0,
  up: 0,
  peers: 6,
  seeds: 1,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: {
    allTimeDownload: 1_000_000_000,
    allTimeUpload: 250_000_000,
    sessionDownload: 500_000_000,
    sessionUpload: 100_000_000,
    wasted: 4096,
    swarmSeeds: 40,
    swarmPeers: 12,
    numConnections: 6,
    connectionsLimit: 200,
    availability: 2.4,
    activeSeconds: 3600,
    seedingSeconds: 120,
    addedAt: 1_755_000_000,
    completedAt: 1_755_003_600,
    lastSeenComplete: 1_755_003_600,
    hadIncoming: true,
    savePath: '/downloads',
    pieceLength: 262_144,
    numPieces: 7630,
    numPiecesHave: 3815,
  },
  files: [
    file('Sintel/Sintel.de.srt', 1_700),
    file('Sintel/Sintel.en.srt', 1_500),
    file('Sintel/Sintel.es.srt', 1_600),
    file('Sintel/Sintel.mp4', 129_200_000),
  ],
}

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 1000px; height: 760px;'
  document.body.append(container)
  return { container }
}

const mount = async (torrent: Torrent | null, torrents: Torrent[] = [SINTEL]) => {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const onToast = vi.fn()
  const screen = await render(
    <EmbedBuilder
      torrents={torrents}
      torrent={torrent}
      dragging={false}
      onSelect={onSelect}
      onClose={onClose}
      onToast={onToast}
    />,
    sized(),
  )
  const url = () => screen.container.querySelector('[data-testid="embed-url"]')!.textContent ?? ''
  const query = () => new URLSearchParams(url().slice(url().indexOf('?')))
  return { screen, onSelect, onClose, onToast, url, query }
}

describe('the embed link builder', () => {
  it('asks for a torrent when it has none, and offers the library', async () => {
    const { screen, onSelect } = await mount(null)
    await expect.element(screen.getByText(/Drop a .torrent or a magnet link/)).toBeInTheDocument()
    await screen.getByRole('button', { name: 'Sintel' }).click()
    expect(onSelect).toHaveBeenCalledWith('7')
  })

  it('defaults to a watch link on the file the player would have picked', async () => {
    const { query } = await mount(SINTEL)
    // index 3 is the mp4; the three subtitles are smaller and not video
    expect(query().get('fileIndex')).toBe('3')
    expect(query().get('mode')).toBeNull()
    expect(atob(query().get('magnet')!)).toBe(SINTEL.magnet)
  })

  /**
   * The player reads `fileIndex` and never `files`, so a set on a watch link is dropped in silence
   * and the embed opens whatever the player chose for itself.
   */
  it('never puts a files list on a watch link', async () => {
    const { query } = await mount(SINTEL)
    expect(query().get('files')).toBeNull()
  })

  it('switches to a download link and drops the file index with it', async () => {
    const { screen, query } = await mount(SINTEL)
    await screen.getByRole('button', { name: 'Download' }).click()
    expect(query().get('mode')).toBe('download')
    expect(query().get('fileIndex')).toBeNull()
    // every file is selected to begin with, and absent already means all
    expect(query().get('files')).toBeNull()
  })

  it('compiles a subset into the shortest range the grammar allows', async () => {
    const { screen, query } = await mount(SINTEL)
    await screen.getByRole('button', { name: 'Download' }).click()
    ;(screen.container.querySelector('.files summary') as HTMLElement).click()
    const boxes = screen.container.querySelectorAll<HTMLInputElement>('.files .file input')
    boxes[0]!.click()
    await expect.poll(() => query().get('files')).toBe('1-3')
    boxes[2]!.click()
    await expect.poll(() => query().get('files')).toBe('1,3')
  })

  /**
   * An absent `files` means ALL, so a link built from an empty selection would hand over the whole
   * torrent. There is no value that means "none", so the panel refuses to show a link at all.
   */
  it('refuses to show a link when nothing is selected rather than widening to everything', async () => {
    const { screen } = await mount(SINTEL)
    await screen.getByRole('button', { name: 'Download' }).click()
    ;(screen.container.querySelector('.files summary') as HTMLElement).click()
    await screen.getByRole('button', { name: 'None' }).click()

    await expect.element(screen.getByText(/Pick at least one file/)).toBeInTheDocument()
    expect(screen.container.querySelector('[data-testid="embed-url"]')).toBeNull()
  })

  it('comes back from empty when a file is checked again', async () => {
    const { screen, query } = await mount(SINTEL)
    await screen.getByRole('button', { name: 'Download' }).click()
    ;(screen.container.querySelector('.files summary') as HTMLElement).click()
    await screen.getByRole('button', { name: 'None' }).click()
    screen.container.querySelectorAll<HTMLInputElement>('.files .file input')[2]!.click()
    await expect.poll(() => query().get('files')).toBe('2')
  })

  /**
   * Sandbox flags are the UNION of the embedder's and the frame's, so a download embed whose host
   * page omits allow-downloads is silently dark: no event fires and nothing throws.
   */
  it('puts allow-downloads in the frame snippet for a download link only', async () => {
    const { screen } = await mount(SINTEL)
    const snippet = () => screen.container.querySelector('[data-testid="embed-iframe"]')!.textContent ?? ''
    ;(screen.container.querySelector('.snippet summary') as HTMLElement).click()
    expect(snippet()).not.toContain('allow-downloads')

    await screen.getByRole('button', { name: 'Download' }).click()
    ;(screen.container.querySelector('.snippet summary') as HTMLElement).click()
    expect(snippet()).toContain('allow-downloads')
  })

  it('still builds a link before the file list arrives, covering the whole torrent', async () => {
    const { screen, query } = await mount({ ...SINTEL, files: undefined })
    expect(query().get('magnet')).not.toBeNull()
    expect(query().get('files')).toBeNull()
    expect(screen.container.querySelector('.files')).toBeNull()
  })

  it('says so instead of showing a broken link when the torrent has no magnet', async () => {
    const { screen } = await mount({ ...SINTEL, magnet: undefined })
    expect(screen.container.querySelector('[data-testid="embed-url"]')).toBeNull()
  })

  it('forgets the previous selection when the subject changes', async () => {
    const other: Torrent = { ...SINTEL, id: '9', name: 'Other', files: [file('Other/a.mkv', 10), file('Other/b.mkv', 20)] }
    const { screen, query } = await mount(SINTEL)
    await screen.getByRole('button', { name: 'Download' }).click()
    ;(screen.container.querySelector('.files summary') as HTMLElement).click()
    screen.container.querySelectorAll<HTMLInputElement>('.files .file input')[0]!.click()
    await expect.poll(() => query().get('files')).toBe('1-3')

    // indices belong to a file list, so carrying them across would name different files entirely
    screen.rerender(
      <EmbedBuilder torrents={[SINTEL, other]} torrent={other} dragging={false} onSelect={vi.fn()} onClose={vi.fn()} onToast={vi.fn()} />,
    )
    await expect.poll(() => query().get('files')).toBeNull()
  })
})
