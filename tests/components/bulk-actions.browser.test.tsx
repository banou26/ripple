import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { BulkBar } from '../../src/components/bulk-actions'
import { IntlRoot } from '../../src/i18n'

/**
 * The bar shown while torrents are ticked. It holds nothing: what each button reaches is the page's, through
 * `toPause` and `toResume`, so what is pinned here is the count, which buttons a person can press, and what each
 * press calls.
 */
const mount = (over: Partial<Parameters<typeof BulkBar>[0]> = {}) => {
  const props = {
    count: 2,
    canPause: true,
    canResume: true,
    onPause: vi.fn(),
    onResume: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    ...over,
  }
  return { props, screen: render(<IntlRoot><BulkBar {...props}/></IntlRoot>) }
}

const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)!

describe('the bulk bar', () => {
  it('says how many are ticked, and sends each press to its own action', async () => {
    const { props, screen } = mount()
    const c = (await screen).container
    expect(c.querySelector('.count')?.textContent).toBe('2 selected')
    for (const [name, call] of [['Pause', props.onPause], ['Resume', props.onResume], ['Remove', props.onRemove], ['Clear selection', props.onClear]] as const) {
      button(c, name).click()
      expect(call, name).toHaveBeenCalledTimes(1)
    }
  })

  it('disables Pause or Resume when it would change none of the ticked torrents', async () => {
    const paused = (await mount({ canPause: false }).screen).container
    expect(button(paused, 'Pause').disabled).toBe(true)
    expect(button(paused, 'Resume').disabled).toBe(false)
    const running = (await mount({ canResume: false }).screen).container
    expect(button(running, 'Pause').disabled).toBe(false)
    expect(button(running, 'Resume').disabled).toBe(true)
    expect(button(running, 'Remove').disabled).toBe(false)
  })
})
