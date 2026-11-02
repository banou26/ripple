import type { Built } from '../../src/torrent/create-source'
import type { CreateState, UseCreateTorrent } from '../../src/torrent/use-create-torrent'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { CreateTorrentDialog } from '../../src/components/create-torrent-dialog'
import { IntlRoot } from '../../src/i18n'
import { forPage } from '../../src/i18n/said'
import { plan } from '../../src/torrent/make-torrent'
import { showEnglish, showIn } from '../i18n/show-in'
import { wordsIn } from '../i18n/words-in'

import de from '../../src/locales/de.json'

afterEach(showEnglish)

const TWO = [{ path: ['Episode 1.mkv'], size: 3_000_000 }, { path: ['Subs', 'Episode 1.srt'], size: 2_000 }]
const V1 = plan({ name: 'Holiday', files: TWO })
const HYBRID = plan({ name: 'Holiday', files: TWO, format: 'hybrid' })
// one file at the root of a folder, which a v2 file tree cannot keep the folder's name for
const ROOT_FILE = plan({ name: 'Holiday', files: [TWO[0]!], format: 'v2' })

const IDLE: CreateState = {
  stage: 'idle', plan: null, skipped: [], truncated: false, progress: null, error: null, built: null, filesFound: 0,
  reopenable: null, room: null, copy: null,
}

const BUILT: Built = {
  infoHash: 'a'.repeat(40), infoHashV2: 'b'.repeat(64), format: 'hybrid', magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
  bytes: new Uint8Array(), plan: HYBRID, handles: [], files: [],
}

const SKIPPED = [
  '.DS_Store',
  forPage.formatMessage({ id: '{path} (could not be read)', defaultMessage: '{path} (could not be read)' }, { path: 'cloud.mkv' }),
  forPage.formatMessage({ id: '{path} (nested too deep)', defaultMessage: '{path} (nested too deep)' }, { path: 'a/b' }),
]

// every state the dialog draws, each branch of each, in the order a pick goes through them
const STATES: Record<string, Partial<CreateState>> = {
  idle: {},
  reading: { stage: 'reading' },
  'reading, files found': { stage: 'reading', filesFound: 3 },
  ready: { stage: 'ready', plan: V1, skipped: SKIPPED, truncated: true, room: { kind: 'fits' } },
  'ready, hybrid': { stage: 'ready', plan: HYBRID, room: { kind: 'short', shortBy: 1_500_000 } },
  'ready, v2 with one file at the root': { stage: 'ready', plan: ROOT_FILE, room: { kind: 'unsafe', element: 'x' } },
  'refused with a plan': { stage: 'error', plan: V1, error: 'Give the torrent a name', room: { kind: 'unknown' } },
  hashing: { stage: 'hashing' },
  'hashing, under way': { stage: 'hashing', progress: { hashedBytes: 1_000_000, totalBytes: 3_002_000, pieces: 1, pieceCount: 12, path: 'Episode 1.mkv' } },
  checking: { stage: 'checking', progress: { hashedBytes: 3_002_000, totalBytes: 3_002_000, pieces: 12, pieceCount: 12, path: 'Subs/Episode 1.srt' } },
  copying: { stage: 'copying' },
  'copying, under way': { stage: 'copying', copy: { file: 0, files: 2, name: 'Holiday/Episode 1.mkv', copiedBytes: 1_000_000, totalBytes: 3_002_000 } },
  'copying, between files': { stage: 'copying', copy: { file: 0, files: 2, name: '', copiedBytes: 0, totalBytes: 3_002_000 } },
  adding: { stage: 'adding' },
  done: { stage: 'done', built: BUILT, plan: HYBRID, reopenable: false, room: { kind: 'short', shortBy: 1 } },
  'refused without a plan': { stage: 'error', error: 'There are no files in there to put in a torrent' },
}

const create = (state: Partial<CreateState>): UseCreateTorrent => ({
  supported: true,
  state: { ...IDLE, ...state },
  suggestedName: 'Holiday',
  pickFolder: async () => {},
  pickFile: async () => {},
  publish: async () => {},
  replan: () => {},
  cancel: () => {},
  reset: () => {},
})

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement

/** What each state shows, by its name. */
const everyState = async () => {
  const shown: Record<string, string[]> = {}
  for (const [name, state] of Object.entries(STATES)) {
    const screen = await render(<CreateTorrentDialog create={create(state)} onClose={() => {}} onShare={() => {}} onToast={() => {}}/>, { wrapper: IntlRoot })
    await expect.poll(dialog).not.toBeNull()
    shown[name] = wordsIn(dialog(), 'textarea')
    await screen.unmount()
  }
  return shown
}

describe('the create dialog in English, as it read before its text was translated', () => {
  it('words every state as it did', async () => {
    const shown = await everyState()
    const choices = ['16 KiB', '32 KiB', '64 KiB', '128 KiB', '256 KiB', '512 KiB', '1 MiB', '2 MiB', '4 MiB', '8 MiB', '16 MiB', '32 MiB', '64 MiB', '128 MiB']
    const form = (size: string) => ['Format', 'v1', 'Hybrid, v1 and v2', 'v2 only', 'Piece size', `Auto (${size})`, ...choices]
    const facts = (p: typeof V1) => ['Files', `${p.files.filter(f => !f.pad).length}`, 'Total size', '3 MB', 'Pieces', `${p.pieceCount}`]
    const fields = ['Name', 'Trackers, one per line', 'Web seeds, comment, source', 'Web seed URLs, one per line', 'Comment', 'Source', 'Private']
    expect(shown).toEqual({
      idle: ['Create a torrent', 'Pick a file or a folder to share.', 'Cancel', 'Choose a file', 'Choose a folder'],
      reading: ['Create a torrent', 'Reading the folder…', 'Cancel'],
      'reading, files found': ['Create a torrent', 'Reading the folder, 3 files so far…', 'Cancel'],
      ready: [
        'Create a torrent', ...facts(V1), ...form('16 KiB'),
        'Too many files for one torrent. Pick a smaller folder.', '3 left out', '.DS_Store', 'cloud.mkv (could not be read)', 'a/b (nested too deep)',
        ...fields, 'Keeps a 3 MB copy in browser storage.', 'Pick something else', 'Create and start sharing',
      ],
      'ready, hybrid': [
        'Create a torrent', ...facts(HYBRID), 'Padding', '29 kB', ...form('16 KiB'),
        ...fields, '1.5 MB short of room for a copy. Sharing stops when this tab closes.', 'Pick something else', 'Create and start sharing',
      ],
      'ready, v2 with one file at the root': [
        'Create a torrent', ...facts(ROOT_FILE), 'Padding', '14.7 kB', ...form('16 KiB').slice(0, 4),
        'v2 loses the folder name Holiday. Hybrid keeps it.', 'Holiday', ...form('16 KiB').slice(4), ...fields,
        'A file name is too long to copy. Sharing stops when this tab closes.', 'Pick something else', 'Create and start sharing',
      ],
      'refused with a plan': [
        'Create a torrent', ...facts(V1), ...form('16 KiB'), ...fields,
        'Give the torrent a name', 'Sharing stops when this tab closes.', 'Pick something else', 'Create and start sharing',
      ],
      hashing: ['Create a torrent', 'Hashing the files…', 'starting…', 'Cancel'],
      'hashing, under way': ['Create a torrent', 'Hashing the files…', '1 MB of 3 MB · Episode 1.mkv', 'Cancel'],
      checking: ['Create a torrent', 'Checking the files…', '3 MB of 3 MB · Subs/Episode 1.srt', 'Cancel'],
      copying: ['Create a torrent', 'Copying to browser storage…', 'starting…', 'Cancel'],
      'copying, under way': ['Create a torrent', 'Copying to browser storage…', '1 MB of 3 MB · Holiday/Episode 1.mkv', 'Cancel'],
      'copying, between files': ['Create a torrent', 'Copying to browser storage…', '0 bytes of 3 MB', 'Cancel'],
      adding: ['Create a torrent', 'Adding…'],
      done: [
        'Create a torrent', 'Holiday is being shared.', 'Holiday', `Info hash ${'a'.repeat(40)}`, 'a'.repeat(40),
        `v2 info hash ${'b'.repeat(64)}`, 'b'.repeat(64), 'Sharing stops when this tab closes or reloads.', 'Close', 'Create another',
        'Copy magnet', 'Get a share link',
      ],
      'refused without a plan': ['Create a torrent', 'There are no files in there to put in a torrent', 'Try again'],
    })
  })

  it('says how long the hashing has left once a second has passed', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const state = STATES['hashing, under way']!
    const screen = await render(<CreateTorrentDialog create={create(state)} onClose={() => {}} onShare={() => {}} onToast={() => {}}/>, { wrapper: IntlRoot })
    now.mockReturnValue(3_000)
    await screen.rerender(<CreateTorrentDialog create={create({ ...state })} onClose={() => {}} onShare={() => {}} onToast={() => {}}/>)
    await expect.poll(() => dialog().querySelector('.faint')?.textContent).toBe('1 MB of 3 MB · about 4s left · Episode 1.mkv')
    now.mockRestore()
  })
})

describe('the create dialog in German', () => {
  it('words every state in German, the walk\'s reasons and the binary units included', async () => {
    await showIn('de', de, 'de-DE')
    const shown = await everyState()
    expect(shown.idle).toEqual(['Torrent erstellen', 'Wähle eine Datei oder einen Ordner zum Teilen.', 'Abbrechen', 'Datei wählen', 'Ordner wählen'])
    expect(shown['reading, files found']).toEqual(['Torrent erstellen', 'Ordner wird gelesen, bisher 3 Dateien…', 'Abbrechen'])
    expect(shown.ready).toEqual(expect.arrayContaining([
      'Dateien', 'Gesamtgröße', '3 MB', 'Teile', 'Format', 'Hybrid, v1 und v2', 'Nur v2', 'Teilgröße', 'Automatisch (16 KiB)', '1 MiB',
      'Zu viele Dateien für einen Torrent. Wähle einen kleineren Ordner.', '3 ausgelassen', 'cloud.mkv (konnte nicht gelesen werden)',
      'a/b (zu tief verschachtelt)', 'Tracker, einer pro Zeile', 'Webseeds, Kommentar, Quelle', 'Privat', 'Behält eine Kopie im Browserspeicher (3 MB).',
      'Etwas anderes wählen', 'Erstellen und teilen',
    ]))
    expect(shown['ready, hybrid']).toContain('Auffüllung')
    expect(shown['ready, v2 with one file at the root']).toContain('v2 verliert den Ordnernamen Holiday. Hybrid behält ihn.')
    expect(shown['hashing, under way']).toEqual(['Torrent erstellen', 'Dateien werden gehasht…', '1 MB von 3 MB · Episode 1.mkv', 'Abbrechen'])
    expect(shown['copying, between files']).toContain('0 Byte von 3 MB')
    expect(shown.done).toEqual(expect.arrayContaining(['Holiday wird geteilt.', `Info-Hash ${'a'.repeat(40)}`, 'Weiteren erstellen', 'Freigabelink erstellen']))
  })
})
