import type { ShareSubject } from '../../src/torrent/torrent-file'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { SYNCED_FILE_CAP } from '../../src/torrent/library'
import { decodeMagnetParam } from '../../src/router/magnet-codec'
import { ShareLinkDialog } from '../../src/components/share-link-dialog'

/**
 * What the dialog puts in the link, which is the only thing about it that can be silently wrong.
 *
 * The two failures worth guarding are both invisible on screen: a watch link carrying a `files` set
 * the player never reads, and an empty selection compiling to an absent `files`, which the embed
 * page reads as EVERY file. Both produce a link that works and delivers the wrong thing.
 *
 * The rest is the empty state, which is new. This used to be a panel with a chip for every torrent
 * in the library; it is now a modal that asks for one it does not have, because sharing something
 * already in the library belongs on that row's own options menu rather than duplicated here.
 */
const file = (name: string, size: number) => ({ name, size })

/**
 * A file list with no pads, where the position IS the engine index.
 *
 * Padded fixtures name their indices explicitly instead, because that is the whole point: a link
 * carries ENGINE indices, and dropping pads renumbers everything after the first one.
 */
const numbered = (entries: { name: string, size: number }[]) => entries.map((e, index) => ({ ...e, index }))

/** The same subject with a different file list, keeping `fileCount` honest against it. */
const withFiles = (
  entries: { name: string, size: number, index: number }[] | null,
  fileCount = entries?.length ?? 0,
): ShareSubject => ({ ...SINTEL, files: entries, fileCount })

const SINTEL: ShareSubject = {
  magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  name: 'Sintel',
  size: 129_300_000,
  files: numbered([
    file('Sintel/Sintel.de.srt', 1_700),
    file('Sintel/Sintel.en.srt', 1_500),
    file('Sintel/Sintel.es.srt', 1_600),
    file('Sintel/Sintel.mp4', 129_200_000),
  ]),
  fileCount: 4,
}

// the shell portals to the body, so nothing here is reachable through the render container
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement

const mount = async (torrent: ShareSubject | null, dragging = false) => {
  const onMagnet = vi.fn<(text: string) => boolean>(() => true)
  const onFiles = vi.fn()
  const onClear = vi.fn()
  const onClose = vi.fn()
  const onToast = vi.fn()
  render(
    <ShareLinkDialog
      torrent={torrent}
      dragging={dragging}
      onMagnet={onMagnet}
      onFiles={onFiles}
      onClear={onClear}
      onClose={onClose}
      onToast={onToast}
    />,
  )
  await expect.poll(dialog).not.toBeNull()
  const url = () => dialog().querySelector('[data-testid="embed-url"]')?.textContent ?? ''
  const query = () => new URLSearchParams(url().slice(url().indexOf('?')))
  return { onMagnet, onFiles, onClear, onClose, onToast, url, query }
}

describe('the share link dialog, before it has a torrent', () => {
  it('is a modal, so it cannot push the library around the way the old panel did', async () => {
    await mount(null)
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(dialog().getAttribute('aria-labelledby')).toBe('share-link-title')
  })

  it('asks for a magnet or a file, and offers no list of what is already here', async () => {
    await mount(null)
    expect(dialog().querySelector('input[aria-label="Magnet link"]')).not.toBeNull()
    expect(dialog().querySelector('input[type="file"]')).not.toBeNull()
    // the whole point of the change: sharing an existing torrent lives on its row, not here
    expect(dialog().textContent).not.toContain('Sintel')
  })

  it('says what the link is for before a torrent is chosen', async () => {
    await mount(null)
    expect(dialog().textContent).toContain('no Ripple account and nothing to install')
  })

  it('hands a pasted magnet to the library rather than adding it itself', async () => {
    const { onMagnet } = await mount(null)
    const field = dialog().querySelector('input[aria-label="Magnet link"]') as HTMLInputElement
    await userEvent.fill(field, SINTEL.magnet!)
    await userEvent.click(dialog().querySelector('button[type="submit"]') as HTMLElement)
    expect(onMagnet).toHaveBeenCalledWith(SINTEL.magnet)
  })

  it('will not submit an empty field', async () => {
    const { onMagnet } = await mount(null)
    const submit = dialog().querySelector('button[type="submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(onMagnet).not.toHaveBeenCalled()
  })

  it('says it is working once something has been handed over, so the submit does not read as a no-op', async () => {
    const { onMagnet } = await mount(null)
    const field = dialog().querySelector('input[aria-label="Magnet link"]') as HTMLInputElement
    await userEvent.fill(field, SINTEL.magnet!)
    await userEvent.click(dialog().querySelector('button[type="submit"]') as HTMLElement)
    expect(onMagnet).toHaveReturnedWith(true)
    await expect.poll(() => dialog().textContent).toContain('Reading the torrent')
  })

  /**
   * The drop zone shows where a drop lands and does NOT take it. The window listener already turns
   * a drop anywhere into an add, so a handler here would add the same file twice.
   */
  it('lights its drop zone while a drag is over the window, without claiming the drop', async () => {
    await mount(null, true)
    const zone = dialog().querySelector('.drop') as HTMLElement
    expect(zone.hasAttribute('data-drop')).toBe(true)
    expect(zone.ondrop).toBeNull()
  })

  it('leaves the zone dark when nothing is being dragged', async () => {
    await mount(null, false)
    expect((dialog().querySelector('.drop') as HTMLElement).hasAttribute('data-drop')).toBe(false)
  })
})

describe('the share link dialog, once it has a torrent', () => {
  it('keeps saying what the link is for', async () => {
    await mount(SINTEL)
    expect(dialog().textContent).toContain('no Ripple account and nothing to install')
  })

  /** download is the default now: it works for every torrent, including ones with nothing playable */
  it('defaults to a download link over the whole torrent', async () => {
    const { query } = await mount(SINTEL)
    expect(query().get('mode')).toBe('download')
    // every file selected means every file, so the grammar says nothing rather than listing them
    expect(query().get('files')).toBeNull()
    expect(query().get('fileIndex')).toBeNull()
    expect(decodeMagnetParam(query())).toBe(SINTEL.magnet)
  })

  it('switches to a watch link on the file the player would have picked', async () => {
    const { query } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    // index 3 is the mp4; the three subtitles are smaller and not video
    await expect.poll(() => query().get('fileIndex')).toBe('3')
    // and the link SAYS it is a watch link, rather than leaving it to be read off an absent param
    expect(query().get('mode')).toBe('watch')
  })

  /**
   * The player reads `fileIndex` and never `files`, so a set on a watch link is dropped in silence
   * and the embed opens whatever the player chose for itself.
   */
  it('never puts a files list on a watch link', async () => {
    const { query } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await expect.poll(() => query().get('fileIndex')).toBe('3')
    expect(query().get('files')).toBeNull()
  })

  it('refuses to show a link when nothing is selected rather than widening to everything', async () => {
    const { url } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    await userEvent.click([...dialog().querySelectorAll('.bulk button')][1] as HTMLElement)
    await expect.poll(() => dialog().textContent).toContain('Pick at least one file')
    expect(url()).toBe('')
  })

  it('comes back from empty when a file is checked again', async () => {
    const { url } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    await userEvent.click([...dialog().querySelectorAll('.bulk button')][1] as HTMLElement)
    await userEvent.click(dialog().querySelector('.file input[type="checkbox"]') as HTMLElement)
    await expect.poll(url).not.toBe('')
  })

  /*
   * A PADDED torrent, where a position and an engine index are different numbers.
   *
   * The link's `files=` is read by the download page as ENGINE indices. The subject's list is
   * pad-filtered, so numbering it 0..n-1 emitted positions instead: a link naming the second
   * episode pointed at the pad, and the recipient downloaded the wrong thing under a right-looking
   * name. Without a pad the two coincide and this cannot fail, which is why the fixture has one.
   */
  const PADDED: ShareSubject = {
    ...SINTEL,
    files: [
      { name: 'Pack/E01.mkv', size: 1_000, index: 0 },
      // index 1 is the pad, which is never in this list
      { name: 'Pack/E02.mkv', size: 2_000, index: 2 },
    ],
    fileCount: 3,
  }

  it('names files by engine index, not by their position after the pads are dropped', async () => {
    const { query } = await mount(PADDED)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    // clear the selection, then take only the SECOND content file, which is engine index 2
    await userEvent.click([...dialog().querySelectorAll('.bulk button')][1] as HTMLElement)
    await userEvent.click([...dialog().querySelectorAll('.file input[type="checkbox"]')][1] as HTMLElement)
    await expect.poll(() => query().get('files')).toBe('2')
  })

  it('keeps every engine index when the whole selection is offered', async () => {
    // 0 and 2 rather than 0-1: the pad at 1 is not the person's file and the link must not claim it
    const { query } = await mount(PADDED)
    await expect.poll(() => query().get('files')).toBe('0,2')
  })

  it('puts allow-downloads in the frame snippet for a download link only', async () => {
    await mount(SINTEL)
    const snippet = () => dialog().querySelector('[data-testid="embed-iframe"]')?.textContent ?? ''
    await userEvent.click(dialog().querySelector('details.snippet summary') as HTMLElement)
    // download is the default, so the flag is there from the start
    expect(snippet()).toContain('allow-downloads')
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await expect.poll(snippet).not.toContain('allow-downloads')
  })

  /**
   * A single-file torrent has nothing to choose between, so neither control is offered. The link
   * must be identical to the one the controls would have produced, which is the half a screenshot
   * cannot check: `compileFileSelection` returns null once a selection covers every file, and
   * `embedPath` omits `fileIndex` when it is 0, so both parameters are absent either way.
   */
  const ONE_FILE = withFiles(numbered([file('Sintel/Sintel.mp4', 129_200_000)]))

  it('offers no file picker when the torrent holds one file', async () => {
    await mount(ONE_FILE)
    expect(dialog().querySelector('#share-file'), 'the watch picker is still there').toBeNull()
    expect(dialog().querySelector('details.files'), 'the download list is still there').toBeNull()
  })

  it('offers none in watch mode either', async () => {
    await mount(ONE_FILE)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await expect.poll(() => dialog().querySelector('[aria-pressed="true"]')?.textContent).toBe('Watch')
    expect(dialog().querySelector('#share-file')).toBeNull()
  })

  it('builds the same link it would have with the picker on screen', async () => {
    const { query } = await mount(ONE_FILE)
    // index 0 is what an absent fileIndex already means, and one of one file is every file
    expect(query().get('fileIndex')).toBeNull()
    expect(query().get('files')).toBeNull()
    expect(decodeMagnetParam(query())).toBe(SINTEL.magnet)
  })

  it('still offers the picker as soon as there are two files to choose between', async () => {
    await mount(withFiles(numbered([file('a.mkv', 2), file('b.srt', 1)])))
    // download is the default, so the list is the picker on screen
    expect(dialog().querySelector('details.files')).not.toBeNull()
  })

  /**
   * Nothing playable means Watch is not offered at all.
   *
   * Offering it would produce a link that opens the player on a file it cannot play, which fails
   * only once somebody else has already clicked it. The note has to say why, or the missing control
   * reads as a bug.
   */
  const NO_MEDIA = withFiles(numbered([file('readme.txt', 10), file('data.zip', 900)]))

  it('offers no Watch option when nothing in the torrent can be played', async () => {
    await mount(NO_MEDIA)
    expect([...dialog().querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Watch')
    expect(dialog().querySelector('.seg')).toBeNull()
  })

  it('says why Watch is missing rather than leaving a gap', async () => {
    await mount(NO_MEDIA)
    expect(dialog().textContent).toContain('nothing here the player can open')
  })

  it('builds a download link for it regardless', async () => {
    const { query } = await mount(NO_MEDIA)
    expect(query().get('mode')).toBe('download')
    expect(decodeMagnetParam(query())).toBe(SINTEL.magnet)
  })

  it('keeps Watch for a magnet whose file list has not arrived, since unknown is not unplayable', async () => {
    await mount(withFiles(null, 0))
    expect([...dialog().querySelectorAll('button')].map((b) => b.textContent)).toContain('Watch')
  })

  it('still builds a link before the file list arrives, covering the whole torrent', async () => {
    const { url, query } = await mount(withFiles(null, 0))
    expect(url()).not.toBe('')
    expect(query().get('files')).toBeNull()
  })

  it('says so instead of showing a broken link when the torrent has no magnet', async () => {
    const { url } = await mount({ ...SINTEL, magnet: '' })
    expect(dialog().textContent).toContain('no magnet yet')
    expect(url()).toBe('')
  })

  it('offers a way back to the empty state, and asks the page to forget the subject', async () => {
    const { onClear } = await mount(SINTEL)
    await userEvent.click([...dialog().querySelectorAll('footer button')]
      .find((b) => b.textContent?.includes('different torrent')) as HTMLElement)
    expect(onClear).toHaveBeenCalled()
  })
})

