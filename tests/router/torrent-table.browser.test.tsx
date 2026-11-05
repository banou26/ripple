import type { Torrent } from '../../src/torrent/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'

import { IntlRoot } from '../../src/i18n'
import de from '../../src/locales/de.json'
import { TorrentTable } from '../../src/router/torrent-table'
import { showEnglish, showIn } from '../i18n/show-in'

/**
 * The dense view of the library.
 *
 * It carries fewer affordances than the cards on purpose, so what is worth pinning is the part that
 * would be silently wrong: that it is a real table a screen reader can navigate, that `aria-sort`
 * names the ordered column and only that one, and that the temporary marker survives here too. A
 * grid of divs would look identical and announce nothing.
 */
let n = 0
const t = (over: Partial<Torrent> = {}): Torrent => ({
  id: 'id-' + (n++),
  name: 'A release',
  size: 1_400_000_000,
  downloaded: 0,
  progress: 0.5,
  state: 'downloading',
  down: 1_000_000,
  up: 2_000,
  peers: 12,
  seeds: 3,
  eta: '2m 00s',
  flags: 0,
  queuePosition: -1,
  stats: null,
  addedAt: Date.now() - 3_600_000,
  ...over,
})

const mount = (over: Partial<Parameters<typeof TorrentTable>[0]> = {}) => {
  const props = {
    torrents: [t()],
    sortKey: 'added' as const,
    sortDir: 'desc' as const,
    onSort: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    onOptions: vi.fn(),
    picked: new Set<string>() as ReadonlySet<string>,
    onPick: vi.fn(),
    ...over,
  }
  return { props, screen: render(<IntlRoot><TorrentTable {...props}/></IntlRoot>) }
}

describe('the torrent table', () => {
  it('is a real table with column headers, so a screen reader can place a cell', async () => {
    const { screen } = mount()
    const c = (await screen).container
    expect(c.querySelector('table')).not.toBeNull()
    expect([...c.querySelectorAll('thead th')].every((th) => th.getAttribute('scope') === 'col')).toBe(true)
  })

  /** exactly one column claims a direction, and the rest say they could be sorted and are not */
  it('marks only the ordered column with aria-sort', async () => {
    const { screen } = mount({ sortKey: 'size', sortDir: 'asc' })
    const c = (await screen).container
    const sorted = [...c.querySelectorAll('th')].filter((th) => {
      const v = th.getAttribute('aria-sort')
      return v === 'ascending' || v === 'descending'
    })
    expect(sorted).toHaveLength(1)
    expect(sorted[0]!.textContent).toContain('Size')
    expect(sorted[0]!.getAttribute('aria-sort')).toBe('ascending')
  })

  /**
   * A column that cannot be sorted must not say `none`, which claims it could be. State is derived
   * from engine flags and has no order worth having.
   */
  it('leaves an unsortable column without a sort state at all', async () => {
    const { screen } = mount()
    const state = [...(await screen).container.querySelectorAll('th')].find((th) => th.textContent?.includes('State'))
    expect(state?.hasAttribute('aria-sort')).toBe(false)
  })

  /* clicked through the DOM: a header button's accessible name is its own text, and the sorted one
     also carries an arrow, so a role query by label is the wrong handle for it */
  const header = (c: HTMLElement, label: string) =>
    [...c.querySelectorAll('thead th button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement

  it('flips the direction when the ordered column is clicked again', async () => {
    const { props, screen } = mount({ sortKey: 'size', sortDir: 'asc' })
    header((await screen).container, 'Size').click()
    expect(props.onSort).toHaveBeenCalledWith('size', 'desc')
  })

  it('starts a different column in the direction that answers it', async () => {
    const { props, screen } = mount({ sortKey: 'name', sortDir: 'asc' })
    header((await screen).container, 'Peers').click()
    expect(props.onSort).toHaveBeenCalledWith('peers', 'desc')
  })

  it('marks a temporary download here too, with the same explanation', async () => {
    const { screen } = mount({ torrents: [t({ ephemeral: true, name: 'cached one' })] })
    const marker = (await screen).container.querySelector('.temp')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('data-tooltip-content')).toMatch(/deleted to free space/)
    expect(marker?.getAttribute('aria-label')).toBe('Temporary download')
  })

  it('leaves an ordinary download unmarked', async () => {
    const { screen } = mount({ torrents: [t({ ephemeral: false })] })
    expect((await screen).container.querySelector('.temp')).toBeNull()
  })

  /**
   * A ghost has no peers and no size to report, and a zero would be a claim rather than an absence.
   * The hyphen is what `eta` already uses for the same reason.
   */
  it('writes a hyphen rather than a zero for what a ghost cannot know', async () => {
    const { screen } = mount({ torrents: [t({ state: 'missing', size: 0, down: 0, up: 0 })] })
    const cells = [...(await screen).container.querySelectorAll('tbody td')].map((td) => td.textContent?.trim())
    expect(cells).toContain('-')
    expect(cells).not.toContain('0')
  })

  it('selects a row when it is clicked', async () => {
    const rows = [t({ name: 'pick me' })]
    const { props, screen } = mount({ torrents: rows })
    await (await screen).getByText('pick me').click()
    expect(props.onSelect).toHaveBeenCalledWith(rows[0])
  })

  it('shows which row the dock is about', async () => {
    const rows = [t(), t()]
    const { screen } = mount({ torrents: rows, selectedId: rows[1]!.id })
    const selected = (await screen).container.querySelectorAll('tbody tr[data-selected]')
    expect(selected).toHaveLength(1)
  })

  // 0.285 is 28.499... as a double, so the bar fills 28% and the figure beside it says the same
  it('rounds the percent as the bar does', async () => {
    const { screen } = mount({ torrents: [t({ progress: 0.285 })] })
    expect((await screen).container.querySelector('.pct')?.textContent).toBe('28%')
  })

  /** The box ticks a row for a bulk action and leaves the dock's row as it was. */
  it('ticks a row from its box without selecting it for the dock', async () => {
    const rows = [t({ infoHash: 'a'.repeat(40), name: 'pick me' })]
    const { props, screen } = mount({ torrents: rows })
    await (await screen).getByRole('checkbox', { name: 'Select pick me' }).click()
    expect(props.onPick).toHaveBeenCalledWith(rows[0])
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('keeps the ticked rows and the dock\'s row apart', async () => {
    const rows = [t({ infoHash: 'b'.repeat(40) }), t({ infoHash: 'c'.repeat(40) })]
    const { screen } = mount({ torrents: rows, picked: new Set([rows[0]!.infoHash!]), selectedId: rows[1]!.id })
    const [first, second] = [...(await screen).container.querySelectorAll('tbody tr')]
    expect(first!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
    expect(first!.hasAttribute('data-selected')).toBe(false)
    expect(second!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    expect(second!.hasAttribute('data-selected')).toBe(true)
  })

  it('offers no box on a row the engine has not reported yet', async () => {
    const { screen } = mount({ torrents: [t({ infoHash: 'd'.repeat(40), state: 'starting' })] })
    expect((await screen).container.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('gives the box a finger-sized area on a phone', async () => {
    await page.viewport(390, 844)
    try {
      const { screen } = mount({ torrents: [t({ infoHash: 'e'.repeat(40) })] })
      const hit = (await screen).container.querySelector('.row-check')!.getBoundingClientRect()
      expect(hit.width).toBeGreaterThanOrEqual(32)
      expect(hit.height).toBeGreaterThanOrEqual(40)
    } finally {
      await page.viewport(1280, 720)
    }
  })

  it('renders a row per torrent and nothing extra', async () => {
    const { screen } = mount({ torrents: [t(), t(), t()] })
    expect((await screen).container.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('words every column, its sort and its row', async () => {
      await showIn('de', de)
      const { screen } = mount({ sortKey: 'size', sortDir: 'asc', torrents: [t({ ephemeral: true, state: 'seeding' })] })
      const c = (await screen).container
      expect([...c.querySelectorAll('thead th button')].map((b) => b.textContent)).toEqual([
        'Name', 'Größe↑', 'Fortschritt', 'Zustand', 'Download', 'Upload', 'Peers', 'Hinzugefügt',
      ])
      expect(c.querySelector('thead .c-size button')?.getAttribute('data-tooltip-content')).toBe('Sortieren nach: Größe')
      expect(c.querySelector('.badge')?.textContent).toBe('Seeden')
      expect(c.querySelector('.pct')?.textContent).toMatch(/^50\s%$/u)
      expect(c.querySelector('.temp')?.getAttribute('aria-label')).toBe('Temporärer Download')
      expect(c.querySelector('.temp')?.getAttribute('data-tooltip-content')).toBe('Kann gelöscht werden, um Platz freizugeben. Öffne die Optionen, um ihn zu behalten.')
    })

    it('says a temporary download is gone once it is', async () => {
      await showIn('de', de)
      const { screen } = mount({ torrents: [t({ ephemeral: true, state: 'missing' })] })
      const c = (await screen).container
      expect(c.querySelector('.temp')?.getAttribute('data-tooltip-content')).toBe('Gelöscht, um Platz freizugeben.')
      expect(c.querySelector('.badge')?.textContent).toBe('Dateien fehlen')
    })
  })
})
