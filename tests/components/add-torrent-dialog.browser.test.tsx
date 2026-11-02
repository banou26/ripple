import type { PersistState } from '../../src/torrent/storage-permission'
import type { TorrentFile } from '../../src/torrent/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { defaultChoices, selectNone } from '../../src/torrent/add-options'

import { AddTorrentDialog } from '../../src/components/add-torrent-dialog'
import { IntlRoot } from '../../src/i18n'
import { showEnglish, showIn } from '../i18n/show-in'
import { wordsIn } from '../i18n/words-in'

import de from '../../src/locales/de.json'

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
      persist={asking()}
      onAskPersist={onAskPersist}
      {...over}
    />,
    { wrapper: IntlRoot },
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

  /** Already persistent, so there is nothing left to ask the browser for and no button to press. */
  it('offers no button where there is nothing to ask for', async () => {
    mount({ persist: asking({ persisted: true, permission: 'granted' }) })
    await expect.poll(() => notice()).not.toBeNull()
    expect(named('Ask for more room')).toBeUndefined()
  })

  /** the documented default: a caller with no reading has nothing to compare, so it says nothing */
  it('stays hidden for a caller that has no storage reading yet', async () => {
    mount({ storage: null })
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(notice()).toBeNull()
  })
})

afterEach(showEnglish)

const TWO = [{ name: 'Big.Buck.Bunny.mkv', size: 4.5 * GB, progress: 0, index: 0 }, { name: 'Extras/Commentary.srt', size: 1_000, progress: 0, index: 1 }]

// every branch of the dialog's text across three shapes
const SHAPES: Record<string, Partial<Props>> = {
  // from another site, nothing picked, a folder to choose and no storage reading
  'sent by a site': {
    external: true, from: 'https://example.org', files: TWO, choices: selectNone(defaultChoices({ fileCount: 2, location: 'browser' })),
    folderReady: true, storage: null,
  },
  'opened from a link': { external: true, files: [], folderReady: true, folderName: 'Downloads', storage: null },
  // their own add, bigger than the room left, with the step on offer to switch off
  'their own': { files: TWO, choices: defaultChoices({ fileCount: 2, location: 'browser' }), onNeverAsk: () => {} },
}

/** What the dialog shows in each shape, by name. */
const everyShape = async () => {
  const shown: Record<string, string[]> = {}
  for (const [name, over] of Object.entries(SHAPES)) {
    const screen = await render(
      <AddTorrentDialog
        name="Big Buck Bunny"
        files={[]}
        choices={defaultChoices({ fileCount: 0, location: 'browser' })}
        onChoices={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        storage={{ usedBytes: 8_800_000_000, limitBytes: 10_000_000_000, persisted: false }}
        persist={asking()}
        onAskPersist={() => {}}
        {...over}
      />,
      { wrapper: IntlRoot },
    )
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull()
    shown[name] = wordsIn(document.querySelector('[role="dialog"]')!)
    await screen.unmount()
  }
  return shown
}

const OPTIONS = ['How it starts', 'Start downloading', 'Download in sequential order', 'Download first and last pieces first', 'Put it first']

describe('the add dialog in English, as it read before its text was translated', () => {
  it('words every shape as it did', async () => {
    expect(await everyShape()).toEqual({
      'sent by a site': [
        'Big Buck Bunny', 'Sent here by https://example.org', 'https://example.org', 'Files', 'Select all', 'Select none',
        '0 B of 4.5 GB, 0 of 2 files', 'Big.Buck.Bunny.mkv', '4.5 GB', 'Extras/Commentary.srt', 'Extras/', '1 kB', 'Choose at least one file.',
        'Where the files go', 'Browser storage', 'Your folder', ...OPTIONS, 'Cancel', 'Add torrent',
      ],
      'opened from a link': ['Big Buck Bunny', 'Opened from a link', 'Files', 'Loading the file list...', 'Where the files go', 'Browser storage', 'Downloads', ...OPTIONS, 'Cancel', 'Add torrent'],
      'their own': [
        'Big Buck Bunny', 'Files', 'Select all', 'Select none', '4.5 GB of 4.5 GB, 2 of 2 files', 'Big.Buck.Bunny.mkv', '4.5 GB',
        'Extras/Commentary.srt', 'Extras/', '1 kB', ...OPTIONS, 'Bigger than the room left', '4.5 GB selected, 1.2 GB free', 'Ask for more room',
        'Do not ask again', 'Cancel', 'Add torrent',
      ],
    })
  })
})

describe('the add dialog in German', () => {
  it('words every shape in German, each count in its form', async () => {
    await showIn('de', de, 'de-DE')
    const options = ['Start', 'Download starten', 'Der Reihe nach downloaden', 'Erste und letzte Teile zuerst laden', 'An den Anfang der Warteschlange stellen']
    expect(await everyShape()).toEqual({
      'sent by a site': [
        'Big Buck Bunny', 'Gesendet von https://example.org', 'https://example.org', 'Dateien', 'Alle wählen', 'Keine wählen',
        '0 Byte von 4,5 GB, 0 von 2 Dateien', 'Big.Buck.Bunny.mkv', '4,5 GB', 'Extras/Commentary.srt', 'Extras/', '1 kB', 'Wähle mindestens eine Datei.',
        'Speicherort', 'Browserspeicher', 'Dein Ordner', ...options, 'Abbrechen', 'Torrent hinzufügen',
      ],
      'opened from a link': ['Big Buck Bunny', 'Über einen Link geöffnet', 'Dateien', 'Dateiliste wird geladen...', 'Speicherort', 'Browserspeicher', 'Downloads', ...options, 'Abbrechen', 'Torrent hinzufügen'],
      'their own': [
        'Big Buck Bunny', 'Dateien', 'Alle wählen', 'Keine wählen', '4,5 GB von 4,5 GB, 2 von 2 Dateien', 'Big.Buck.Bunny.mkv', '4,5 GB',
        'Extras/Commentary.srt', 'Extras/', '1 kB', ...options, 'Größer als der freie Platz', '4,5 GB ausgewählt, 1,2 GB frei', 'Mehr Platz anfragen',
        'Nicht mehr fragen', 'Abbrechen', 'Torrent hinzufügen',
      ],
    })
  })
})
