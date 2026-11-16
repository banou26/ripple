import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'

import { ListToolbar } from '../../src/components/list-toolbar'
import { IntlRoot } from '../../src/i18n'
import de from '../../src/locales/de.json'
import fr from '../../src/locales/fr.json'
import { showEnglish, showIn } from '../i18n/show-in'

/**
 * The controls over what the library shows.
 *
 * Everything here reports upward and holds nothing, so what is worth pinning is that each control
 * says which option is live, and that choosing a sort key sends the direction that answers the
 * question it was chosen to ask rather than whatever was set last.
 */
const COUNTS = { all: 6, library: 4, temporary: 2, downloading: 2, seeding: 2, completed: 1, paused: 0, missing: 1, retrying: 0 }

const mount = (over: Partial<Parameters<typeof ListToolbar>[0]> = {}) => {
  const props = {
    filter: 'all' as const,
    onFilter: vi.fn(),
    sortKey: 'added' as const,
    sortDir: 'desc' as const,
    onSort: vi.fn(),
    view: 'cards' as const,
    onView: vi.fn(),
    counts: COUNTS,
    picked: 'none' as 'none' | 'some' | 'all',
    canPick: true,
    onPickAll: vi.fn(),
    ...over,
  }
  return { props, screen: render(<IntlRoot><ListToolbar {...props}/></IntlRoot>) }
}

const pressed = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name))?.getAttribute('aria-pressed')

const chip = (c: HTMLElement, which: 'show' | 'sort') => c.querySelector<HTMLButtonElement>(`.chip.${which}`)!

/** Opens the chip's menu and returns its rows. */
const opened = async (c: HTMLElement, which: 'show' | 'sort') => {
  chip(c, which).click()
  await expect.poll(() => c.querySelector('[role="menu"]')).not.toBeNull()
  return [...c.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]')]
}

const names = (rows: HTMLElement[]) => rows.map((row) => row.getAttribute('aria-label') ?? row.textContent)
const checked = (rows: HTMLElement[]) => names(rows.filter((row) => row.getAttribute('aria-checked') === 'true'))

describe('the list toolbar', () => {
  /** One box for every row shown, ticked when all are, mixed when some are. */
  it('ticks every row shown from one box, and says when only some are', async () => {
    const box = async (over: Parameters<typeof mount>[0]) => {
      const { props, screen } = mount(over)
      // by the container: four renders share the page, and a role query reads the whole of it
      return { props, input: (await screen).container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Select all"]')! }
    }
    const none = await box({ picked: 'none' })
    expect([none.input.checked, none.input.indeterminate]).toEqual([false, false])
    const some = await box({ picked: 'some' })
    expect([some.input.checked, some.input.indeterminate]).toEqual([false, true])
    const all = await box({ picked: 'all' })
    expect([all.input.checked, all.input.indeterminate]).toEqual([true, false])
    all.input.click()
    expect(all.props.onPickAll).toHaveBeenCalledTimes(1)
    expect((await box({ canPick: false })).input.disabled).toBe(true)
  })

  it('names the filter with its count, the sort key with its direction, and the view, on the controls themselves', async () => {
    const { screen } = mount({ filter: 'library', sortKey: 'size', sortDir: 'asc', view: 'table' })
    const c = (await screen).container
    expect(chip(c, 'show').innerText.replace(/\s+/g, ' ').trim()).toBe('Kept 4')
    expect(chip(c, 'show')).toHaveAccessibleName('Show: Kept (4)')
    expect(chip(c, 'sort').innerText.trim()).toBe('Size')
    expect(chip(c, 'sort')).toHaveAccessibleName('Sort by Size')
    expect(chip(c, 'sort').getAttribute('data-tooltip-content')).toBe('Smallest first')
    expect(pressed(c, 'Table')).toBe('true')
    expect([chip(c, 'show'), chip(c, 'sort')].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
  })

  it('offers each filter that shows a row, with how many it shows, the one chosen checked', async () => {
    const { screen } = mount({ filter: 'seeding' })
    const c = (await screen).container
    const rows = await opened(c, 'show')
    expect(chip(c, 'show').getAttribute('aria-expanded')).toBe('true')
    expect(names(rows)).toEqual(['All (6)', 'Kept (4)', 'Temporary (2)', 'Downloading (2)', 'Seeding (2)', 'Completed (1)', 'Not on this device (1)'])
    expect(checked(rows)).toEqual(['Seeding (2)'])
  })

  /**
   * The state most people are in permanently. An option that cannot change an outcome is not shown, and
   * a filter offering to hide a category with nothing in it teaches the wrong thing about the app.
   */
  it('offers neither Kept nor Temporary when nothing is temporary', async () => {
    const { screen } = mount({ counts: { ...COUNTS, all: 4, temporary: 0 } })
    expect(names(await opened((await screen).container, 'show'))).toEqual(['All (4)', 'Downloading (2)', 'Seeding (2)', 'Completed (1)', 'Not on this device (1)'])
  })

  it('still names the chosen filter once it shows nothing', async () => {
    const { screen } = mount({ filter: 'paused' })
    const c = (await screen).container
    expect(chip(c, 'show')).toHaveAccessibleName('Show: Paused (0)')
    expect(names(await opened(c, 'show'))).toContain('Paused (0)')
  })

  it('reports each filter when chosen, and puts its menu away', async () => {
    const { props, screen } = mount()
    const c = (await screen).container
    const rows = await opened(c, 'show')
    rows.find((row) => row.getAttribute('aria-label') === 'Seeding (2)')!.click()
    expect(props.onFilter).toHaveBeenCalledWith('seeding')
    await expect.poll(() => c.querySelector('[role="menu"]')).toBeNull()
  })

  /**
   * Picking "Size" means "biggest first", not "whatever direction the last key happened to use".
   * Getting this wrong is invisible: the list simply answers a question nobody asked.
   */
  it('starts a newly chosen key in the direction that answers it', async () => {
    const { props, screen } = mount({ sortKey: 'name', sortDir: 'asc' })
    const rows = await opened((await screen).container, 'sort')
    rows.find((row) => row.textContent === 'Size')!.click()
    expect(props.onSort).toHaveBeenCalledWith('size', 'desc')
  })

  it('flips the direction when the key already chosen is chosen again, and says so on that row', async () => {
    const { props, screen } = mount({ sortKey: 'size', sortDir: 'desc' })
    const row = (await opened((await screen).container, 'sort')).find((row) => row.getAttribute('aria-checked') === 'true')!
    expect(row).toHaveAccessibleName('Size')
    expect(row).toHaveAccessibleDescription('Sorted descending, click for ascending')
    row.click()
    expect(props.onSort).toHaveBeenCalledWith('size', 'asc')
  })

  it('offers every sort key the rules define', async () => {
    const { screen } = mount()
    expect(names(await opened((await screen).container, 'sort'))).toEqual(['Date added', 'Name', 'Size', 'Progress', 'Download speed', 'Upload speed', 'Peers', 'Time left'])
  })

  it('shows Cards and Table as icons on a phone, each still named for a screen reader', async () => {
    const words = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('.views button')].map((b) => b.innerText.trim())
    expect(words((await mount().screen).container), 'the control: the words show on a wide window').toEqual(['Cards', 'Table'])
    await page.viewport(390, 844)
    try {
      const c = (await mount().screen).container
      expect(words(c)).toEqual(['', ''])
      const [cards, table] = c.querySelectorAll('.views button')
      expect(cards).toHaveAccessibleName('Cards')
      expect(table).toHaveAccessibleName('Table')
    } finally {
      await page.viewport(1280, 720)
    }
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('words every control and every sort key', async () => {
      await showIn('de', de)
      const { screen } = mount({ sortDir: 'asc' })
      const c = (await screen).container
      expect([...c.querySelectorAll('.views button')].map((b) => b.textContent)).toEqual(['Karten', 'Tabelle'])
      expect([...c.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Ansicht'])
      expect(chip(c, 'show')).toHaveAccessibleName('Anzeigen: Alle (6)')
      expect(chip(c, 'sort')).toHaveAccessibleName('Sortieren nach: Hinzugefügt am')
      expect(chip(c, 'sort').getAttribute('data-tooltip-content')).toBe('Kleinste zuerst')
      const filters = await opened(c, 'show')
      expect(c.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Anzeigen')
      expect(names(filters)).toEqual([
        'Alle (6)', 'Behalten (4)', 'Temporär (2)', 'Lädt herunter (2)', 'Seeden (2)', 'Abgeschlossen (1)', 'Nicht auf diesem Gerät (1)',
      ])
      chip(c, 'show').click()
      await expect.poll(() => c.querySelector('[role="menu"]')).toBeNull()
      const sorts = await opened(c, 'sort')
      expect(c.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Sortieren')
      expect(names(sorts)).toEqual([
        'Hinzugefügt am', 'Name', 'Größe', 'Fortschritt', 'Download-Geschwindigkeit', 'Upload-Geschwindigkeit', 'Peers', 'Restzeit',
      ])
      expect(sorts[0]).toHaveAccessibleDescription('Aufsteigend sortiert, klicken für absteigend')
    })

    // a row's chip is one temporary download, the filter is all of them
    it('names the filters in the plural, as a group', async () => {
      await showIn('fr', fr)
      const { screen } = mount()
      expect(names(await opened((await screen).container, 'show'))).toEqual([
        'Tous (6)', 'Conservés (4)', 'Temporaires (2)', 'Téléchargement (2)', 'Partage (2)', 'Terminés (1)', 'Pas sur cet appareil (1)',
      ])
    })

    it('words the other direction', async () => {
      await showIn('de', de)
      const { screen } = mount({ sortDir: 'desc' })
      const c = (await screen).container
      expect(chip(c, 'sort').getAttribute('data-tooltip-content')).toBe('Größte zuerst')
      expect((await opened(c, 'sort'))[0]).toHaveAccessibleDescription('Absteigend sortiert, klicken für aufsteigend')
    })
  })
})
