import type { ShareSubject } from '../torrent/torrent-file'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

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

  it('defaults to a watch link on the file the player would have picked', async () => {
    const { query } = await mount(SINTEL)
    // index 3 is the mp4; the three subtitles are smaller and not video
    expect(query().get('fileIndex')).toBe('3')
    // watch is the default, so the link says nothing rather than saying so
    expect(query().get('mode')).toBeNull()
    expect(atob(query().get('magnet')!)).toBe(SINTEL.magnet)
  })

  it('never puts a files list on a watch link', async () => {
    const { query } = await mount(SINTEL)
    expect(query().get('files')).toBeNull()
  })

  it('switches to a download link and drops the file index with it', async () => {
    const { query } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    expect(query().get('mode')).toBe('download')
    expect(query().get('fileIndex')).toBeNull()
  })

  it('refuses to show a link when nothing is selected rather than widening to everything', async () => {
    const { url } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    await userEvent.click([...dialog().querySelectorAll('.bulk button')][1] as HTMLElement)
    await expect.poll(() => dialog().textContent).toContain('Pick at least one file')
    expect(url()).toBe('')
  })

  it('comes back from empty when a file is checked again', async () => {
    const { url } = await mount(SINTEL)
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await userEvent.click(dialog().querySelector('details.files summary') as HTMLElement)
    await userEvent.click([...dialog().querySelectorAll('.bulk button')][1] as HTMLElement)
    await userEvent.click(dialog().querySelector('.file input[type="checkbox"]') as HTMLElement)
    await expect.poll(url).not.toBe('')
  })

  it('puts allow-downloads in the frame snippet for a download link only', async () => {
    await mount(SINTEL)
    const snippet = () => dialog().querySelector('[data-testid="embed-iframe"]')?.textContent ?? ''
    await userEvent.click(dialog().querySelector('details.snippet summary') as HTMLElement)
    expect(snippet()).not.toContain('allow-downloads')
    await userEvent.click(dialog().querySelector('button[aria-pressed="false"]') as HTMLElement)
    await expect.poll(snippet).toContain('allow-downloads')
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
