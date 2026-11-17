import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'

import type { GroupChoice } from '../../src/components/list-toolbar'

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
const GROUPS = [{ id: 'g1', name: 'Week 2', count: 3 }, { id: 'g2', name: 'Weekend watch list', count: 0 }]

const grouping = (over: Partial<GroupChoice> = {}): GroupChoice => ({
  list: GROUPS, shown: null, all: 6, onShow: vi.fn(), onNew: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), ...over,
})

const mount = (over: Partial<Parameters<typeof ListToolbar>[0]> = {}) => {
  const props = {
    filter: 'all' as const,
    onFilter: vi.fn(),
    group: grouping(),
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

const chip = (c: HTMLElement, which: 'show' | 'group' | 'sort') => c.querySelector<HTMLButtonElement>(`.chip.${which}`)!

/** Opens the chip's menu and returns its rows. */
const opened = async (c: HTMLElement, which: 'show' | 'group' | 'sort') => {
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
    expect(chip(c, 'sort')).toHaveAccessibleName('Sort by Size, ascending')
    expect(chip(c, 'sort').getAttribute('data-tooltip-content')).toBe('Smallest first')
    expect(chip(c, 'sort').querySelector('svg')).toHaveClass('lucide-arrow-up-narrow-wide')
    expect(pressed(c, 'Table')).toBe('true')
    expect([chip(c, 'show'), chip(c, 'sort')].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    const other = (await mount({ sortKey: 'size', sortDir: 'desc' }).screen).container
    expect(chip(other, 'sort')).toHaveAccessibleName('Sort by Size, descending')
    expect(chip(other, 'sort').getAttribute('data-tooltip-content')).toBe('Largest first')
    expect(chip(other, 'sort').querySelector('svg')).toHaveClass('lucide-arrow-down-wide-narrow')
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

  it('hangs each menu from the start of its chip, and keeps the views at the far end', async () => {
    const c = (await mount().screen).container
    const box = (element: Element) => element.getBoundingClientRect()
    expect(box(c.querySelector('.views')!).right).toBeCloseTo(box(c.querySelector('.list-toolbar')!).right, 0)
    for (const which of ['show', 'group', 'sort'] as const) {
      await opened(c, which)
      await expect.poll(() => box(c.querySelector('[role="menu"]')!).left, { message: which }).toBeCloseTo(box(chip(c, which)).left, 0)
      chip(c, which).click()
      await expect.poll(() => c.querySelector('[role="menu"]')).toBeNull()
    }
  })

  it('offers every sort key the rules define', async () => {
    const { screen } = mount()
    expect(names(await opened((await screen).container, 'sort'))).toEqual(['Date added', 'Name', 'Size', 'Progress', 'Download speed', 'Upload speed', 'Peers', 'Time left'])
  })

  describe('the Group chip', () => {
    const actions = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
    const labels = (c: HTMLElement) => [...c.querySelectorAll('[role="menu"] .group > label')].map((label) => label.textContent)

    it('names the group shown, or says Group while every torrent is, between Show and Sort', async () => {
      const c = (await mount().screen).container
      expect([...c.querySelectorAll('.chip')].map((b) => b.classList[1])).toEqual(['show', 'group', 'sort'])
      expect(chip(c, 'group').innerText.trim()).toBe('Group')
      expect(chip(c, 'group')).toHaveAccessibleName('Group: All torrents (6)')
      expect(chip(c, 'group').querySelector('svg')).toHaveClass('lucide-layers')
      const shown = (await mount({ group: grouping({ shown: 'g1' }) }).screen).container
      expect(chip(shown, 'group').innerText.trim()).toBe('Week 2')
      expect(chip(shown, 'group')).toHaveAccessibleName('Group: Week 2 (3)')
      expect(chip(shown, 'group').querySelector('.value')!.getAttribute('dir')).toBe('auto')
    })

    it('offers every torrent and each group with its count, the one shown checked, and New group...', async () => {
      const { props, screen } = mount({ group: grouping({ shown: 'g2' }) })
      const c = (await screen).container
      const rows = await opened(c, 'group')
      expect(c.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Group')
      expect(names(rows)).toEqual(['All torrents (6)', 'Week 2 (3)', 'Weekend watch list (0)'])
      expect(checked(rows)).toEqual(['Weekend watch list (0)'])
      rows[1]!.click()
      expect(props.group.onShow).toHaveBeenCalledWith('g1')
      await expect.poll(() => c.querySelector('[role="menu"]')).toBeNull()
      ;(await opened(c, 'group'))[0]!.click()
      expect(props.group.onShow).toHaveBeenLastCalledWith(null)
      await opened(c, 'group')
      actions(c).find((row) => row.textContent === 'New group...')!.click()
      expect(props.group.onNew).toHaveBeenCalledTimes(1)
    })

    it('offers Rename... and Delete group for the group shown, and Download all only while it can fetch one', async () => {
      const none = (await mount().screen).container
      await opened(none, 'group')
      expect(actions(none).map((row) => row.textContent), 'every torrent shown: nothing to rename').toEqual(['New group...'])
      expect(labels(none)).toEqual(['Group'])
      chip(none, 'group').click()

      const held = (await mount({ group: grouping({ shown: 'g1' }) }).screen).container
      await opened(held, 'group')
      expect(actions(held).map((row) => row.textContent)).toEqual(['New group...', 'Rename...', 'Delete group'])
      expect(labels(held)).toEqual(['Group', 'Week 2'])
      chip(held, 'group').click()

      const { props, screen } = mount({ group: grouping({ shown: 'g1', onDownloadAll: vi.fn() }) })
      const c = (await screen).container
      for (const [name, call] of [['Download all', props.group.onDownloadAll], ['Rename...', props.group.onRename], ['Delete group', props.group.onDelete]] as const) {
        await opened(c, 'group')
        const row = actions(c).find((one) => one.textContent === name)!
        if (name === 'Delete group') expect(row).toHaveClass('danger')
        row.click()
        expect(call, name).toHaveBeenCalledTimes(1)
        await expect.poll(() => c.querySelector('[role="menu"]')).toBeNull()
      }
    })
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
      expect(chip(c, 'sort')).toHaveAccessibleName('Sortieren nach: Hinzugefügt am, aufsteigend')
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
      expect(chip(c, 'sort')).toHaveAccessibleName('Sortieren nach: Hinzugefügt am, absteigend')
      expect(chip(c, 'sort').getAttribute('data-tooltip-content')).toBe('Größte zuerst')
      expect((await opened(c, 'sort'))[0]).toHaveAccessibleDescription('Absteigend sortiert, klicken für aufsteigend')
    })
  })
})
