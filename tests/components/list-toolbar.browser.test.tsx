import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

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

const shown = (c: HTMLElement) => c.querySelector<HTMLSelectElement>('label.show select')!
const sorted = (c: HTMLElement) => c.querySelector<HTMLSelectElement>('label.sort select')!
const options = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent)

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

  it('says which filter, sort direction and view are live', async () => {
    const { screen } = mount({ filter: 'library', view: 'table' })
    const c = (await screen).container
    expect(shown(c)).toHaveValue('library')
    expect(pressed(c, 'Table')).toBe('true')
    expect(sorted(c)).toHaveValue('added')
  })

  it('offers each filter that shows a row, with how many it shows', async () => {
    const { screen } = mount()
    const select = (await screen).getByRole('combobox', { name: 'Show' }).element() as HTMLSelectElement
    expect(options(select)).toEqual(['All (6)', 'Kept (4)', 'Temporary (2)', 'Downloading (2)', 'Seeding (2)', 'Completed (1)', 'Not on this device (1)'])
  })

  /**
   * The state most people are in permanently. An option that cannot change an outcome is not shown, and
   * a filter offering to hide a category with nothing in it teaches the wrong thing about the app.
   */
  it('offers neither Kept nor Temporary when nothing is temporary', async () => {
    const { screen } = mount({ counts: { ...COUNTS, all: 4, temporary: 0 } })
    expect(options(shown((await screen).container))).toEqual(['All (4)', 'Downloading (2)', 'Seeding (2)', 'Completed (1)', 'Not on this device (1)'])
  })

  it('still names the chosen filter once it shows nothing', async () => {
    const { screen } = mount({ filter: 'paused' })
    const select = shown((await screen).container)
    expect(select).toHaveValue('paused')
    expect(select.selectedOptions[0]?.textContent).toBe('Paused (0)')
  })

  it('reports each filter when chosen', async () => {
    const { props, screen } = mount()
    await (await screen).getByRole('combobox', { name: 'Show' }).selectOptions('seeding')
    expect(props.onFilter).toHaveBeenCalledWith('seeding')
  })

  /**
   * Picking "Size" means "biggest first", not "whatever direction the last key happened to use".
   * Getting this wrong is invisible: the list simply answers a question nobody asked.
   */
  it('starts a newly chosen key in the direction that answers it', async () => {
    const { props, screen } = mount({ sortKey: 'name', sortDir: 'asc' })
    const select = sorted((await screen).container)
    select.value = 'size'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(props.onSort).toHaveBeenCalledWith('size', 'desc')
  })

  it('flips the direction without changing the key', async () => {
    const { props, screen } = mount({ sortKey: 'size', sortDir: 'desc' })
    await (await screen).getByRole('button', { name: /Sorted descending/ }).click()
    expect(props.onSort).toHaveBeenCalledWith('size', 'asc')
  })

  it('offers every sort key the rules define', async () => {
    const { screen } = mount()
    expect([...sorted((await screen).container).options].map((o) => o.value)).toEqual(['added', 'name', 'size', 'progress', 'down', 'up', 'peers', 'eta'])
  })

  it('names the direction control for a screen reader, since it is only an arrow', async () => {
    const { screen } = mount({ sortDir: 'asc' })
    expect((await screen).container.querySelector('.dir')?.getAttribute('aria-label')).toMatch(/ascending/)
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('words every control and every sort key', async () => {
      await showIn('de', de)
      const { screen } = mount({ sortDir: 'asc' })
      const c = (await screen).container
      expect([...c.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['', 'Karten', 'Tabelle'])
      expect([...c.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Ansicht'])
      expect(c.querySelector('label.show')?.firstChild?.textContent).toBe('Anzeigen')
      expect(shown(c).getAttribute('aria-label')).toBe('Anzeigen')
      expect(options(shown(c))).toEqual([
        'Alle (6)', 'Behalten (4)', 'Temporär (2)', 'Lädt herunter (2)', 'Seeden (2)', 'Abgeschlossen (1)', 'Nicht auf diesem Gerät (1)',
      ])
      expect(c.querySelector('label.sort')?.firstChild?.textContent).toBe('Sortieren')
      expect(sorted(c).getAttribute('aria-label')).toBe('Sortieren nach')
      expect(options(sorted(c))).toEqual([
        'Hinzugefügt am', 'Name', 'Größe', 'Fortschritt', 'Download-Geschwindigkeit', 'Upload-Geschwindigkeit', 'Peers', 'Restzeit',
      ])
      expect(c.querySelector('.dir')?.getAttribute('aria-label')).toBe('Aufsteigend sortiert, klicken für absteigend')
      expect(c.querySelector('.dir')?.getAttribute('data-tooltip-content')).toBe('Kleinste zuerst')
    })

    // a row's chip is one temporary download, the filter is all of them
    it('names the filters in the plural, as a group', async () => {
      await showIn('fr', fr)
      const { screen } = mount()
      expect(options(shown((await screen).container))).toEqual([
        'Tous (6)', 'Conservés (4)', 'Temporaires (2)', 'Téléchargement (2)', 'Partage (2)', 'Terminés (1)', 'Pas sur cet appareil (1)',
      ])
    })

    it('words the other direction', async () => {
      await showIn('de', de)
      const { screen } = mount({ sortDir: 'desc' })
      const c = (await screen).container
      expect(c.querySelector('.dir')?.getAttribute('aria-label')).toBe('Absteigend sortiert, klicken für aufsteigend')
      expect(c.querySelector('.dir')?.getAttribute('data-tooltip-content')).toBe('Größte zuerst')
    })
  })
})
