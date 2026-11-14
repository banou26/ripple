import type { Reachability } from '../../src/torrent/client'
import type { EngineTransport } from '../../src/torrent/vpn-config'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { IntlRoot } from '../../src/i18n'
import de from '../../src/locales/de.json'
import { showEnglish, showIn } from '../i18n/show-in'

/**
 * The VPN's switch, and the readout it grew out of.
 *
 * The readout exists because of a real session spent debugging the wrong thing. Every torrent sat on
 * "Loading torrent…" with zero peers, no failed request and no page error, and the only evidence
 * anywhere was a console line and the absence of a WebSocket. Nothing on screen said the transport
 * was not up. So the first tests below are mostly about the UNREACHABLE and RECONNECTING states, which
 * is where the value is: a readout that is only ever correct when things work would not have helped.
 *
 * The switch is drawn off the moment that is chosen, and on once the engine is behind the relay; its word
 * is the engine's, which follows the choice late. Switching off shows a person's IP address to strangers, so
 * it asks first.
 */

const SENTENCE = 'Peers and trackers of every running torrent will see your IP address.'
const COUNTRY = 'In your country, sharing copyrighted files this way can lead to a demand for money.'

const page = vi.hoisted(() => ({ setVpn: vi.fn(), listed: false, asked: 0 }))

// whatever the constant is set to in the source, this file is about the switch being there
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))
// the engine's page half, which stores the choice and has the engine follow it
vi.mock('../../src/torrent/client', () => ({ setVpn: page.setVpn }))
vi.mock('../../src/torrent/country-line', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/country-line')>()),
  inListedCountry: () => { page.asked++; return page.listed },
}))

beforeEach(async () => {
  localStorage.clear()
  page.listed = false
  page.asked = 0
  const { storeVpn } = await import('../../src/torrent/vpn-setting')
  page.setVpn.mockReset().mockImplementation(async (on: boolean) => { storeVpn(on) })
})

const reach = (over: Partial<Reachability> = {}): Reachability => ({
  listening: { tcp: '0.0.0.0:41337' },
  listenFailed: [],
  inbound: 0,
  inboundByTransport: {},
  lastInbound: null,
  port: 41337,
  listeners: [{ transport: 'tcp', port: 41337, up: true, healing: false, attempts: 0 }],
  portOpen: true,
  ...over,
})
const NO_PORT = reach({ port: null, listeners: [] })
const HEALING = reach({ port: null, listeners: [{ transport: 'tcp', port: null, up: false, healing: true, attempts: 1 }] })

const switchOf = async (reachable: Reachability | null, transport?: EngineTransport) => {
  const { VpnSwitch } = await import('../../src/components/vpn-switch')
  return <IntlRoot><VpnSwitch reachable={reachable} transport={transport}/></IntlRoot>
}
const mount = async (reachable: Reachability | null, transport: EngineTransport = 'relay') => render(await switchOf(reachable, transport))
/** With the VPN switched off in this storage, and the engine running with it off unless `transport` says otherwise. */
const mountOff = (reachable: Reachability | null = NO_PORT, transport: EngineTransport = 'direct') => {
  localStorage.setItem('ripple:vpn', 'off')
  return mount(reachable, transport)
}

const strong = (c: HTMLElement) => c.querySelector('strong')
const stat = (c: HTMLElement) => c.querySelector('.stat.vpn') as HTMLElement
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null

describe('the VPN switch says what the engine runs on', () => {
  it('says On when the relay holds a port and a socket is bound to it', async () => {
    const { container } = await mount(reach())
    expect(strong(container)?.textContent).toBe('On')
    expect(strong(container)?.className).toContain('ok')
  })

  /**
   * The state that cost a session. A signed-out app reserves no relay port, so nothing carries peer
   * traffic, and every other readout on the strip looks unremarkable while it happens.
   */
  it('says Unreachable when the relay never reserved a port', async () => {
    const { container } = await mount(NO_PORT)
    expect(strong(container)?.textContent).toBe('Unreachable')
    expect(stat(container).className).toContain('error')
  })

  it('says Unreachable when a port was reserved but nothing is bound to it', async () => {
    const { container } = await mount(reach({
      listeners: [{ transport: 'tcp', port: null, up: false, healing: false, attempts: 3 }],
    }))
    expect(strong(container)?.textContent).toBe('Unreachable')
  })

  /**
   * Off is somebody's choice, so it is one word of its own with nothing to act on: an engine with no relay has
   * no port and no listener either, which is exactly what Unreachable reads.
   */
  it('says Off, with no warning and nothing to do, when the engine runs with the VPN off', async () => {
    const { container } = await mountOff()
    expect(strong(container)?.textContent).toBe('Off')
    expect(stat(container).className).not.toContain('error')
    expect(stat(container).getAttribute('data-tooltip-content')).toBeNull()
    localStorage.clear()
    const fault = await mount(NO_PORT)
    expect(getComputedStyle(strong(container)!).color).not.toBe(getComputedStyle(strong(fault.container)!).color)
  })

  it('says Off before an engine with the VPN off has said where it can be reached', async () => {
    const { container } = await mountOff(null)
    expect(strong(container)?.textContent).toBe('Off')
  })

  it('says Reconnecting rather than Unreachable while the tunnel is being reclaimed', async () => {
    const { container } = await mount(HEALING)
    expect(strong(container)?.textContent).toBe('Reconnecting')
  })

  it('survives an engine too old to send listeners, rather than taking the route down', async () => {
    const legacy = {
      listening: { tcp: '0.0.0.0:41337' },
      listenFailed: [],
      inbound: 3,
      inboundByTransport: { tcp: 3 },
      lastInbound: null,
      port: 41337,
    } as unknown as Reachability
    const { container } = await mount(legacy)
    // no `listeners` means nothing is known to be bound, so it cannot claim On
    expect(strong(container)?.textContent).toBe('Unreachable')
  })

  /**
   * Colour is not the only carrier. The strip is read at a glance and the palette is monochrome
   * apart from status hues, so the word has to differ too.
   */
  it('says a different WORD in each state, not only a different colour', async () => {
    const words = new Set<string>()
    for (const reachable of [reach(), NO_PORT, HEALING]) {
      const screen = await mount(reachable)
      words.add(strong(screen.container)!.textContent)
      await screen.unmount()
    }
    words.add(strong((await mountOff()).container)!.textContent)
    expect([...words]).toEqual(['On', 'Unreachable', 'Reconnecting', 'Off'])
  })

  it('says what to do about Unreachable, since nothing else on screen does', async () => {
    const { container } = await mount(NO_PORT)
    expect(stat(container).getAttribute('data-tooltip-content')).toMatch(/reloading/)
  })

  /**
   * Mounted in two headers that share no rule. Without its own declarations it renders there as
   * unstyled text: the same words, saying nothing at a glance.
   */
  it('brings its own colours rather than borrowing a page\'s', async () => {
    const on = await mount(reach())
    const unreachable = await mount(NO_PORT)
    const colour = (c: HTMLElement) => getComputedStyle(strong(c)!).color
    expect(colour(on.container)).not.toBe(colour(unreachable.container))
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('words each state, and what to do about Unreachable', async () => {
      await showIn('de', de)
      const on = await mount(reach())
      expect(strong(on.container)?.textContent).toBe('An')
      const unreachable = await mount(NO_PORT)
      expect(strong(unreachable.container)?.textContent).toBe('Nicht erreichbar')
      expect(stat(unreachable.container).getAttribute('data-tooltip-content')).toBe('Keine Peers können sich verbinden. Lade die Seite neu.')
      const healing = await mount(HEALING)
      expect(strong(healing.container)?.textContent).toBe('Verbindet neu')
      const waiting = await mount(reach(), 'direct')
      expect(strong(waiting.container)?.textContent).toBe('Wartet')
      const off = await mountOff()
      expect(strong(off.container)?.textContent).toBe('Aus')
    })
  })
})

describe('the switch is drawn from the stored choice, and never on before the engine is behind the relay', () => {
  it('is a switch named VPN, on until somebody switches it off', async () => {
    const screen = await mount(reach())
    const control = screen.getByRole('switch', { name: /^VPN/ })
    await expect.element(control).toBeInTheDocument()
    expect(control.element().getAttribute('aria-checked')).toBe('true')
    expect(control.element().tagName).toBe('BUTTON')
  })

  it('shows the choice before any engine has spoken, with no word yet', async () => {
    const on = await mount(null)
    expect(on.getByRole('switch').element().getAttribute('aria-checked')).toBe('true')
    expect(strong(on.container)?.textContent).toBe('')
    await on.unmount()
    const off = await mountOff(null, 'relay')
    expect(off.getByRole('switch').element().getAttribute('aria-checked')).toBe('false')
  })

  // the engine is replaced, which waits while a page saves a file: until then the word is neither On nor Off
  it('says Waiting, with no warning colour, while the engine has yet to follow the choice', async () => {
    const turnedOff = await mountOff(reach(), 'relay')
    expect(strong(turnedOff.container)?.textContent).toBe('Waiting')
    expect(stat(turnedOff.container).className).not.toContain('error')
    expect(stat(turnedOff.container).getAttribute('aria-checked')).toBe('false')
    await turnedOff.unmount()
    localStorage.clear()
    const turnedOn = await mount(NO_PORT, 'direct')
    expect(strong(turnedOn.container)?.textContent).toBe('Waiting')
  })

  // switched back on, the engine follows once no page saves a file, and peers see the address until it has
  it('is drawn off at once, and on only once the engine is behind the relay', async () => {
    const screen = await mountOff()
    expect(stat(screen.container).getAttribute('aria-checked')).toBe('false')
    await screen.getByRole('switch').click()
    expect(page.setVpn.mock.calls).toEqual([[true]])
    expect(strong(screen.container)?.textContent).toBe('Waiting')
    expect(stat(screen.container).getAttribute('aria-checked'), 'drawn on while the engine has no relay').toBe('false')
    // the thumb rests where it does for Off
    expect(Number.parseFloat(getComputedStyle(screen.container.querySelector('.track')!, '::after').marginLeft)).toBe(0)

    await screen.rerender(await switchOf(reach(), 'relay'))
    expect(strong(screen.container)?.textContent).toBe('On')
    expect(stat(screen.container).getAttribute('aria-checked')).toBe('true')

    // THE OTHER WAY: off is drawn before the engine has followed
    localStorage.setItem('ripple:vpn-off-remembered', '1')
    await screen.getByRole('switch').click()
    expect(strong(screen.container)?.textContent).toBe('Waiting')
    expect(stat(screen.container).getAttribute('aria-checked')).toBe('false')
  })

  it('follows a change another page of this storage made', async () => {
    const screen = await mount(reach())
    localStorage.setItem('ripple:vpn', 'off')
    window.dispatchEvent(new StorageEvent('storage', { key: 'ripple:vpn', newValue: 'off' }))
    await expect.poll(() => screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('false')
    expect(strong(screen.container)?.textContent).toBe('Waiting')
    // and a key that is not the VPN's is not a change of it
    localStorage.removeItem('ripple:vpn')
    window.dispatchEvent(new StorageEvent('storage', { key: 'ripple:language' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the choice it had where the browser refuses to store another', async () => {
    page.setVpn.mockImplementation(async () => {})
    page.listed = false
    localStorage.setItem('ripple:vpn-off-remembered', '1')
    const screen = await mount(reach())
    await screen.getByRole('switch').click()
    expect(page.setVpn).toHaveBeenCalledWith(false)
    expect(screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('true')
  })

  it('swaps the sides of its thumb and its word where text runs right to left', async () => {
    const drawn = async (dir: 'ltr' | 'rtl', off: boolean) => {
      if (off) localStorage.setItem('ripple:vpn', 'off'); else localStorage.removeItem('ripple:vpn')
      const { VpnSwitch } = await import('../../src/components/vpn-switch')
      const screen = await render(<IntlRoot><div dir={dir} style={{ width: 400 }}><VpnSwitch reachable={reach()} transport={off ? 'direct' : 'relay'}/></div></IntlRoot>)
      const track = screen.container.querySelector('.track')!
      const thumb = getComputedStyle(track, '::after')
      const out = {
        track: track.getBoundingClientRect(),
        word: strong(screen.container)!.getBoundingClientRect(),
        thumb: { left: Number.parseFloat(thumb.marginLeft), right: Number.parseFloat(thumb.marginRight) },
      }
      await screen.unmount()
      return out
    }
    const ltr = await drawn('ltr', false)
    const rtl = await drawn('rtl', false)
    expect(ltr.track.right).toBeLessThanOrEqual(ltr.word.left)
    expect(rtl.track.left).toBeGreaterThanOrEqual(rtl.word.right)
    // on, the thumb is pushed away from the side the text starts on; off, it rests there
    expect(ltr.thumb).toEqual({ left: 12, right: 0 })
    expect(rtl.thumb).toEqual({ left: 0, right: 12 })
    expect((await drawn('rtl', true)).thumb).toEqual({ left: 0, right: 0 })
  })
})

describe('switching the VPN off asks first', () => {
  it('shows one sentence, the box to tick and two actions, with the focus on Cancel', async () => {
    const screen = await mount(reach())
    await screen.getByRole('switch').click()
    await expect.poll(dialog).not.toBeNull()
    expect(page.setVpn, 'the VPN was switched off before the answer').not.toHaveBeenCalled()

    const card = dialog()!
    expect(card.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe(SENTENCE)
    expect([...card.querySelectorAll('p')].map((p) => p.textContent)).toEqual([SENTENCE])
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Cancel', 'Turn off'])
    expect([...card.querySelectorAll('input')].map((input) => [input.type, input.checked])).toEqual([['checkbox', false]])
    // nothing else in it: every word it shows is one of those
    expect(card.textContent).toBe(`${SENTENCE}Remember this decisionCancelTurn off`)
    expect(document.activeElement?.textContent).toBe('Cancel')
  })

  it('leaves the VPN on when cancelled, by the button, by Escape and by a click beside the card', async () => {
    const screen = await mount(reach())
    const cancels = [
      () => userEvent.click(dialog()!.querySelector('button')!),
      () => userEvent.keyboard('{Escape}'),
      () => userEvent.click(dialog()!, { position: { x: 5, y: 5 } }),
    ]
    for (const cancel of cancels) {
      await screen.getByRole('switch').click()
      await expect.poll(dialog).not.toBeNull()
      await cancel()
      await expect.poll(dialog).toBeNull()
      expect(page.setVpn).not.toHaveBeenCalled()
      expect(localStorage.length, 'something was stored by a cancelled warning').toBe(0)
      expect(screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('true')
    }
    // the focus is back on the switch, where the keyboard left it
    expect(document.activeElement).toBe(screen.getByRole('switch').element())
  })

  it('switches off once confirmed, and asks again the next time', async () => {
    const screen = await mount(reach())
    await screen.getByRole('switch').click()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.poll(dialog).toBeNull()
    expect(page.setVpn.mock.calls).toEqual([[false]])
    expect(screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('false')
    expect(Object.keys(localStorage)).toEqual(['ripple:vpn'])

    // back on asks nothing
    await screen.getByRole('switch').click()
    expect(dialog()).toBeNull()
    expect(page.setVpn.mock.calls).toEqual([[false], [true]])
    expect(screen.getByRole('switch').element().getAttribute('aria-checked')).toBe('true')

    await screen.getByRole('switch').click()
    await expect.poll(dialog).not.toBeNull()
  })

  it('is not shown again once Remember this decision was ticked and the VPN switched off', async () => {
    const screen = await mount(reach())
    await screen.getByRole('switch').click()
    await screen.getByRole('checkbox', { name: 'Remember this decision' }).click()
    await screen.getByRole('button', { name: 'Turn off' }).click()
    await expect.poll(dialog).toBeNull()
    expect(page.setVpn.mock.calls).toEqual([[false]])

    await screen.getByRole('switch').click()
    await screen.getByRole('switch').click()
    expect(dialog()).toBeNull()
    expect(page.setVpn.mock.calls).toEqual([[false], [true], [false]])
    await screen.unmount()

    // nor by another switch of this storage, as each surface has its own
    localStorage.removeItem('ripple:vpn')
    const other = await mount(reach())
    await other.getByRole('switch').click()
    expect(dialog()).toBeNull()
    expect(page.setVpn).toHaveBeenLastCalledWith(false)
  })

  it('remembers nothing when the box was ticked and the warning cancelled', async () => {
    const screen = await mount(reach())
    await screen.getByRole('switch').click()
    await screen.getByRole('checkbox', { name: 'Remember this decision' }).click()
    await screen.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(dialog).toBeNull()
    expect(localStorage.length).toBe(0)
    await screen.getByRole('switch').click()
    await expect.poll(dialog).not.toBeNull()
    expect((dialog()!.querySelector('input') as HTMLInputElement).checked, 'the box came back ticked').toBe(false)
  })

  it('is pressed with Space and with Enter, as with a pointer', async () => {
    const screen = await mount(reach())
    for (const key of [' ', '{Enter}']) {
      screen.getByRole('switch').element().focus()
      await userEvent.keyboard(key)
      await expect.poll(dialog, { message: `the key ${JSON.stringify(key)} opened nothing` }).not.toBeNull()
      await userEvent.keyboard('{Escape}')
      await expect.poll(dialog).toBeNull()
    }
    // and the two actions are reached with Tab alone, which never leaves the card
    await screen.getByRole('switch').click()
    await expect.poll(dialog).not.toBeNull()
    const reached: string[] = []
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}')
      reached.push(document.activeElement?.textContent || (document.activeElement as HTMLInputElement).type)
    }
    expect(reached).toEqual(['Turn off', 'checkbox', 'Cancel', 'Turn off'])
  })

  describe('in a listed country', () => {
    it('adds the second sentence, asked as the warning is drawn and not before', async () => {
      page.listed = true
      const screen = await mount(reach())
      expect(page.asked, 'the country was asked for before any warning').toBe(0)
      await screen.getByRole('switch').click()
      await expect.poll(dialog).not.toBeNull()
      expect([...dialog()!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([SENTENCE, COUNTRY])
      expect(page.asked).toBeGreaterThan(0)
      // and nothing about the answer is kept
      await screen.getByRole('button', { name: 'Turn off' }).click()
      await expect.poll(dialog).toBeNull()
      expect(Object.entries(localStorage)).toEqual([['ripple:vpn', 'off']])
      expect(sessionStorage.length).toBe(0)
    })

    it('never asks for the country once Remember this decision is set', async () => {
      page.listed = true
      localStorage.setItem('ripple:vpn-off-remembered', '1')
      const screen = await mount(reach())
      await screen.getByRole('switch').click()
      await screen.getByRole('switch').click()
      await screen.getByRole('switch').click()
      expect(page.setVpn.mock.calls).toEqual([[false], [true], [false]])
      expect(dialog()).toBeNull()
      expect(page.asked).toBe(0)
    })
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('words the warning, its box and its actions', async () => {
      await showIn('de', de)
      page.listed = true
      const screen = await mount(reach())
      await screen.getByRole('switch').click()
      await expect.poll(dialog).not.toBeNull()
      expect(dialog()!.textContent).toBe([
        'Peers und Tracker jedes laufenden Torrents werden deine IP-Adresse sehen.',
        'In deinem Land kann das Teilen urheberrechtlich geschützter Dateien auf diese Weise zu einer Geldforderung führen.',
        'Diese Entscheidung merken', 'Abbrechen', 'Ausschalten',
      ].join(''))
    })
  })
})

/*
 * The word changes while somebody is looking at the header, and a word that grows shoves whatever sits beside
 * the switch. Each case runs in each font below, because a room sized for one font holds in that font only
 * (tests/stable-widths.spec.ts has the measurements that taught it).
 */
describe('the word keeps its room', () => {
  afterEach(showEnglish)

  const FONTS: Record<string, string> = {
    'device font': '',
    'monospace fallback': 'body * { font-family: monospace !important }',
    'reader text spacing': 'body * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important }',
  }

  it('moves nothing beside the switch in any state, language or font', async () => {
    const { VpnSwitch } = await import('../../src/components/vpn-switch')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    expect(languages).toHaveLength(13)
    // the five words: on, reconnecting, unreachable, off, and waiting each way
    const states: { reachable: Reachability | null, transport: EngineTransport, off: boolean }[] = [
      { reachable: reach(), transport: 'relay', off: false },
      { reachable: HEALING, transport: 'relay', off: false },
      { reachable: NO_PORT, transport: 'relay', off: false },
      { reachable: NO_PORT, transport: 'direct', off: true },
      { reachable: reach(), transport: 'relay', off: true },
    ]
    const sheet = document.head.appendChild(document.createElement('style'))
    const moved: string[] = []
    const words = new Set<string>()
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        for (const [font, css] of Object.entries(FONTS)) {
          sheet.textContent = css
          const spots: string[] = []
          for (const { reachable, transport, off } of states) {
            if (off) localStorage.setItem('ripple:vpn', 'off'); else localStorage.removeItem('ripple:vpn')
            const screen = await render(
              <IntlRoot><div style={{ display: 'flex', width: 600 }}><VpnSwitch reachable={reachable} transport={transport}/><span data-testid="beside">beside</span></div></IntlRoot>,
            )
            const { left, top } = screen.getByTestId('beside').element().getBoundingClientRect()
            spots.push(`${left},${top}`)
            words.add(`${language}: ${strong(screen.container)!.textContent}`)
            await screen.unmount()
          }
          if (new Set(spots).size !== 1) moved.push(`${language}, ${font}: what follows the switch moved to ${spots.join(' ')}`)
        }
      }
    } finally { sheet.remove() }
    // each state drew a word of its own in each language, so none was measured as another
    expect(words.size).toBe(13 * 5)
    expect(moved).toEqual([])
  }, 60_000)
})
