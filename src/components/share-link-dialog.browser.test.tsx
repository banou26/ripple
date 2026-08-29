import type { ShareSubject } from '../torrent/torrent-file'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { decodeFileList } from '../router/file-list-codec'
import { SYNCED_FILE_CAP } from '../torrent/library'
import { decodeMagnetParam } from '../router/magnet-codec'
import { ShareLinkDialog } from './share-link-dialog'

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

const SINTEL: ShareSubject = {
  magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel',
  name: 'Sintel',
  size: 129_300_000,
  files: [
    file('Sintel/Sintel.de.srt', 1_700),
    file('Sintel/Sintel.en.srt', 1_500),
    file('Sintel/Sintel.es.srt', 1_600),
    file('Sintel/Sintel.mp4', 129_200_000),
  ],
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
    // watch is the grammar's default, so the link says nothing rather than saying so
    expect(query().get('mode')).toBeNull()
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
  const ONE_FILE = { ...SINTEL, files: [file('Sintel/Sintel.mp4', 129_200_000)] }

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
    await mount({ ...SINTEL, files: [file('a.mkv', 2), file('b.srt', 1)] })
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
  const NO_MEDIA = { ...SINTEL, files: [file('readme.txt', 10), file('data.zip', 900)] }

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
    await mount({ ...SINTEL, files: null })
    expect([...dialog().querySelectorAll('button')].map((b) => b.textContent)).toContain('Watch')
  })

  it('still builds a link before the file list arrives, covering the whole torrent', async () => {
    const { url, query } = await mount({ ...SINTEL, files: null })
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

/**
 * The dialog's half of the file-list preview.
 *
 * Worth its own block because nothing else in the repo would notice this being disconnected: the
 * codec has thorough tests of its own and the download page has tests for rendering a preview, so
 * both ends can be green while the link that joins them carries no `f=` at all. That is the exact
 * shape of the miss that shipped a broken script earlier in this work.
 */
describe('the file list the link carries', () => {
  it('puts the whole list on a download link', async () => {
    const { query } = await mount(SINTEL)
    const value = query().get('f')
    expect(value, 'the download link carries no file list').not.toBeNull()
    expect(decodeFileList(value!)).toEqual(SINTEL.files!.map((f) => ({ path: f.name, size: f.size })))
  })

  it('carries the WHOLE list, not just the selection, because files= indexes into it', async () => {
    const { query } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    const boxes = [...dialog().querySelectorAll('details.files input[type="checkbox"]')] as HTMLInputElement[]
    // drop one file from the selection, so files= becomes a strict subset
    if (boxes.length > 1) await userEvent.click(boxes[0]!)
    await expect.poll(() => query().get('files')).not.toBeNull()
    expect(decodeFileList(query().get('f')!)).toHaveLength(SINTEL.files!.length)
  })

  it('leaves it off a magnet with no file list, which is every plain paste', async () => {
    const { query } = await mount({ ...SINTEL, files: null })
    expect(query().get('f')).toBeNull()
  })

  /**
   * A library entry's list is truncated at SYNCED_FILE_CAP, and a truncated list cannot be told
   * apart from a complete one of that length. Emitting it would state a wrong count and a wrong
   * total as fact, so the preview is dropped instead.
   */
  it('says nothing rather than something short when the list may be truncated', async () => {
    const many = Array.from({ length: SYNCED_FILE_CAP }, (_, i) => file(`Pack/E${i}.mkv`, 1_000 + i))
    const capped = await mount({ ...SINTEL, files: many })
    expect(capped.query().get('f'), 'a possibly-truncated list was published as fact').toBeNull()
  })

  it('keeps the preview one file under the cap, where the list is knowably complete', async () => {
    const fewer = Array.from({ length: SYNCED_FILE_CAP - 1 }, (_, i) => file(`Pack/E${i}.mkv`, 1_000 + i))
    const { query } = await mount({ ...SINTEL, files: fewer })
    expect(query().get('f')).not.toBeNull()
  })
})
