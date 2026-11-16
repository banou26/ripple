import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'

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
    expect(button(c, 'Pause').querySelector('svg')!.classList).toContain('lucide-pause')
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

  it('offers Download only while a ticked torrent is not on this device, and sends the press to it', async () => {
    expect(button((await mount().screen).container, 'Download')).toBeUndefined()
    const { props, screen } = mount({ canDownload: true, onDownload: vi.fn() })
    const c = (await screen).container
    expect(button(c, 'Download').querySelector('svg')!.classList).toContain('lucide-download')
    button(c, 'Download').click()
    expect(props.onDownload).toHaveBeenCalledTimes(1)
  })

  it('offers Copy magnets, sends the press to it, and holds it while the magnets are read', async () => {
    const reading = (await mount().screen).container
    expect(button(reading, 'Copy magnets').disabled).toBe(true)
    const { props, screen } = mount({ onCopyMagnets: vi.fn() })
    const c = (await screen).container
    const copy = button(c, 'Copy magnets')
    expect(copy.disabled).toBe(false)
    expect(copy.querySelector('svg')!.classList).toContain('lucide-magnet')
    expect(copy.getAttribute('data-tooltip-content')).toBe('Copy magnets')
    copy.click()
    expect(props.onCopyMagnets).toHaveBeenCalledTimes(1)
  })

  it('shows Remove as its icon on a phone, still named for a screen reader', async () => {
    const remove = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button.danger')!
    expect(remove((await mount().screen).container).innerText.trim(), 'the control: the word shows on a wide window').toBe('Remove')
    await page.viewport(390, 844)
    try {
      const shown = remove((await mount().screen).container)
      expect(shown.innerText.trim()).toBe('')
      expect(shown).toHaveAccessibleName('Remove')
    } finally {
      await page.viewport(1280, 720)
    }
  })

  it('says Stop and Start when every ticked torrent is finished, for the same two actions', async () => {
    const { props, screen } = mount({ finished: true })
    const c = (await screen).container
    expect(button(c, 'Pause')).toBeUndefined()
    expect(button(c, 'Stop').querySelector('svg')!.classList).toContain('lucide-square')
    expect(button(c, 'Start').querySelector('svg')!.classList).toContain('lucide-play')
    button(c, 'Stop').click()
    button(c, 'Start').click()
    expect(props.onPause).toHaveBeenCalledTimes(1)
    expect(props.onResume).toHaveBeenCalledTimes(1)
  })
})
