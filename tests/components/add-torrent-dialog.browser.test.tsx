import type { PersistState } from '../../src/torrent/storage-permission'
import type { TorrentFile } from '../../src/torrent/types'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { defaultChoices } from '../../src/torrent/add-options'

import { AddTorrentDialog } from '../../src/components/add-torrent-dialog'

/**
 * "This will not fit", said where the decision is made.
 *
 * The case it was written for: a browser hands this origin a budget of its own choosing, measured at
 * a flat 10 GiB on Chrome 151 with 2.8 TiB free (2026-08-30), and until now nothing said a word
 * about it until the download had already stopped part way through. The dialog is the one screen
 * where the size is known and nothing has been written yet.
 *
 * What is worth pinning here is mostly what the notice must NOT do. It must not block the add, since
 * eviction, the folder route and the persistent-storage ask can each make room, and someone who
 * knows that is not making a mistake. It must not appear for a selection that fits. It must not
 * offer a button on a browser that has already answered, which on Chromium is every browser. And a
 * caller that has no storage reading to give it must get silence rather than a guess.
 */

const GB = 1_000_000_000

const files = (...sizes: number[]): TorrentFile[] =>
  sizes.map((size, index) => ({ name: `file-${index}.mkv`, size, progress: 0, index }))

const asking = (over: Partial<PersistState> = {}): PersistState => ({
  persisted: false,
  permission: 'prompt',
  attempted: false,
  granted: null,
  ...over,
})

type Props = Parameters<typeof AddTorrentDialog>[0]

const mount = (over: Partial<Props> = {}) => {
  const list = over.files ?? files(4.5 * GB)
  const onConfirm = vi.fn()
  const onAskPersist = vi.fn()
  render(
    <AddTorrentDialog
      name="Big Buck Bunny"
      files={list}
      choices={defaultChoices({ fileCount: list.length, location: 'browser' })}
      onChoices={() => {}}
      onConfirm={onConfirm}
      onCancel={() => {}}
      // 1.2 GB of room left, against a 4.5 GB selection unless a test says otherwise
      storage={{ usedBytes: 8_800_000_000, limitBytes: 10_000_000_000, persisted: false }}
      relief={{ kind: 'choose' }}
      persist={asking()}
      onAskPersist={onAskPersist}
      {...over}
    />,
  )
  return { onConfirm, onAskPersist }
}

const notice = () => document.querySelector('.fit')
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const named = (label: string) => buttons().find((b) => b.textContent === label)

describe('the add dialog when the selection is bigger than the room left', () => {
  it('states both figures rather than only that it is too big', async () => {
    mount()
    // polled rather than read straight: the notice arrives with the modal's portal, one turn later
    await expect.poll(() => notice()?.textContent).toContain('4.5 GB')
    expect(notice()?.textContent).toContain('1.2 GB')
  })

  it('says nothing at all about a selection that fits', async () => {
    mount({ files: files(900_000_000) })
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(notice()).toBeNull()
  })

  /**
   * The whole point of it being a notice. Eviction can free best-effort bytes, the folder route
   * moves finished downloads out, and on Firefox the ask beside it moved the reported quota from
   * 12 GB to 3.97 TB. A disabled confirm would be Ripple deciding all three of those went the
   * wrong way.
   */
  it('does not block the add', async () => {
    const { onConfirm } = mount()
    await expect.poll(() => notice()).not.toBeNull()
    const add = named('Add torrent')!
    expect(add.disabled).toBe(false)
    add.click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('offers the ask, and calls back exactly once for it', async () => {
    const { onAskPersist } = mount()
    await expect.poll(() => named('Ask for more room')).not.toBeUndefined()
    named('Ask for more room')!.click()
    expect(onAskPersist).toHaveBeenCalledTimes(1)
  })

  /**
   * Already persistent, so there is nothing left to ask the browser for. The folder route takes the
   * place of the button rather than a button being left there to press into an answered question.
   */
  it('offers the folder route and no button where there is nothing to ask for', async () => {
    mount({ persist: asking({ persisted: true, permission: 'granted' }) })
    await expect.poll(() => notice()).not.toBeNull()
    expect(named('Ask for more room')).toBeUndefined()
    expect(notice()?.textContent).toContain('a folder on your computer')
  })

  /** the documented default: a caller with no reading has nothing to compare, so it says nothing */
  it('stays hidden for a caller that has no storage reading yet', async () => {
    mount({ storage: null })
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(notice()).toBeNull()
  })
})
