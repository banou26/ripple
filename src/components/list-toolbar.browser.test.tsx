import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { ListToolbar } from './list-toolbar'

/**
 * The controls over what the library shows.
 *
 * Everything here reports upward and holds nothing, so what is worth pinning is that each control
 * says which option is live, and that choosing a sort key sends the direction that answers the
 * question it was chosen to ask rather than whatever was set last.
 */
const mount = (over: Partial<Parameters<typeof ListToolbar>[0]> = {}) => {
  const props = {
    filter: 'all' as const,
    onFilter: vi.fn(),
    sortKey: 'added' as const,
    sortDir: 'desc' as const,
    onSort: vi.fn(),
    view: 'cards' as const,
    onView: vi.fn(),
    temporaryCount: 2,
    ...over,
  }
  return { props, screen: render(<ListToolbar {...props}/>) }
}

const pressed = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name))?.getAttribute('aria-pressed')

describe('the list toolbar', () => {
  it('says which filter, sort direction and view are live', async () => {
    const { screen } = mount({ filter: 'library', view: 'table' })
    const c = (await screen).container
    expect(pressed(c, 'Kept')).toBe('true')
    expect(pressed(c, 'All')).toBe('false')
    expect(pressed(c, 'Table')).toBe('true')
    expect(c.querySelector('select')).toHaveValue('added')
  })

  it('counts the temporary downloads on the filter itself', async () => {
    const { screen } = mount({ temporaryCount: 7 })
    expect((await screen).container.textContent).toContain('7')
  })

  /**
   * The state most people are in permanently. A filter offering to hide a category with nothing in
   * it is a control that cannot change an outcome, and it teaches the wrong thing about the app.
   */
  it('hides the filter entirely when nothing is temporary', async () => {
    const { screen } = mount({ temporaryCount: 0 })
    const c = (await screen).container
    expect(pressed(c, 'Kept')).toBeUndefined()
    // the view switch is still there: it is not about temporary downloads
    expect(pressed(c, 'Cards')).toBe('true')
  })

  it('reports each filter when chosen', async () => {
    const { props, screen } = mount()
    await (await screen).getByRole('button', { name: /Temporary/ }).click()
    expect(props.onFilter).toHaveBeenCalledWith('temporary')
  })

  /**
   * Picking "Size" means "biggest first", not "whatever direction the last key happened to use".
   * Getting this wrong is invisible: the list simply answers a question nobody asked.
   */
  it('starts a newly chosen key in the direction that answers it', async () => {
    const { props, screen } = mount({ sortKey: 'name', sortDir: 'asc' })
    const select = (await screen).container.querySelector('select')!
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
    const options = [...(await screen).container.querySelectorAll('option')].map((o) => o.value)
    expect(options).toEqual(['added', 'name', 'size', 'progress', 'down', 'up', 'peers', 'eta'])
  })

  it('names the direction control for a screen reader, since it is only an arrow', async () => {
    const { screen } = mount({ sortDir: 'asc' })
    expect((await screen).container.querySelector('.dir')?.getAttribute('aria-label')).toMatch(/ascending/)
  })
})
