import type { Reachability } from '../../src/torrent/client'

import { css } from '@emotion/react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * The WebVPN readout.
 *
 * It exists because of a real session spent debugging the wrong thing. Every torrent sat on
 * "Loading torrent…" with zero peers, no failed request and no page error, and the only evidence
 * anywhere was a console line and the absence of a WebSocket. Nothing on screen said the transport
 * was not up. This is that missing sentence.
 *
 * So the tests below are mostly about the OFF and RECONNECTING states, which is where the value is.
 * A readout that is only ever correct when things work would not have helped.
 *
 * It also has to survive an engine older than itself, for the reason connection-stat.browser.test
 * spells out: a deploy is not atomic, `engine-share` hands a tab state produced by whichever tab
 * owns the engine, and a stat that throws takes the whole route down with it.
 */

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

const mount = async (reachable: Reachability | null) => {
  const { VpnStat } = await import('../../src/components/vpn-stat')
  return render(<VpnStat reachable={reachable}/>)
}

const strong = (c: HTMLElement) => c.querySelector('strong')

/**
 * The library strip, reduced to the one rule of it that reaches inside this component.
 *
 * `.stats svg` in router/home.tsx sizes the speed graph, and its selector matches every svg in the
 * panel. Copied rather than imported because importing home pulls the engine client and the whole
 * library page in behind it, which is a lot of machinery to stand up to measure one icon. If the
 * rule in home changes, this stops reproducing it, which is the honest cost of the copy: the
 * assertion is that the component holds its own box against a hostile ancestor, and this is one.
 */
const strip = css`
  svg {
    flex: 1;
    min-width: 120px;
    height: 52px;
    align-self: center;
  }
`

describe('the VPN stat', () => {
  it('says On when the relay holds a port and a socket is bound to it', async () => {
    const { container } = await mount(reach())
    expect(strong(container)?.textContent).toBe('On')
    expect(strong(container)?.className).toContain('ok')
  })

  /**
   * The state that cost a session. A signed-out app reserves no relay port, so nothing carries peer
   * traffic, and every other readout on the strip looks unremarkable while it happens.
   */
  it('says Off when the relay never reserved a port', async () => {
    const { container } = await mount(reach({ port: null, listeners: [] }))
    expect(strong(container)?.textContent).toBe('Off')
    expect(container.querySelector('.stat.vpn')?.className).toContain('error')
  })

  it('says Off when a port was reserved but nothing is bound to it', async () => {
    const { container } = await mount(reach({
      listeners: [{ transport: 'tcp', port: null, up: false, healing: false, attempts: 3 }],
    }))
    expect(strong(container)?.textContent).toBe('Off')
  })

  it('says Reconnecting rather than Off while the tunnel is being reclaimed', async () => {
    const { container } = await mount(reach({
      port: null,
      listeners: [{ transport: 'tcp', port: null, up: false, healing: true, attempts: 1 }],
    }))
    expect(strong(container)?.textContent).toBe('Reconnecting')
  })

  /** nothing known yet is not the same as off, and saying off would invent a fault out of a gap */
  it('renders nothing at all before the engine has said anything', async () => {
    const { container } = await mount(null)
    expect(container.querySelector('.stat.vpn')).toBeNull()
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
    expect(strong(container)?.textContent).toBe('Off')
  })

  /**
   * Colour is not the only carrier. The strip is read at a glance and the palette is monochrome
   * apart from status hues, so the word has to differ too.
   */
  it('says a different WORD in each state, not only a different colour', async () => {
    const on = await mount(reach())
    const off = await mount(reach({ port: null, listeners: [] }))
    expect(strong(on.container)?.textContent).not.toBe(strong(off.container)?.textContent)
  })

  it('explains what Off means for downloads, since nothing else on screen does', async () => {
    const { container } = await mount(reach({ port: null, listeners: [] }))
    expect(container.querySelector('.stat.vpn')?.getAttribute('data-tooltip-content')).toMatch(/Loading torrent/)
  })

  /**
   * The state title says what is happening NOW. The glyph says what the readout is, which is a
   * different question and the one somebody meeting the word "VPN" on a torrent page actually has.
   * A browser shows the NEAREST title, so the glyph carrying its own is what keeps the two apart.
   */
  it('carries an explainer of its own on the info glyph, not only a state title', async () => {
    const { container } = await mount(reach())
    const info = container.querySelector('.stat.vpn .info')
    expect(info, 'no info affordance at all').not.toBeNull()
    expect(info?.getAttribute('data-tooltip-content')).toMatch(/WebVPN/)
    // and it is not simply repeating the state line above it
    expect(info?.getAttribute('data-tooltip-content')).not.toBe(container.querySelector('.stat.vpn')?.getAttribute('data-tooltip-content'))
  })

  it('keeps the explainer in the Off state too, where it is needed most', async () => {
    const { container } = await mount(reach({ port: null, listeners: [] }))
    expect(container.querySelector('.stat.vpn .info')?.getAttribute('data-tooltip-content')).toMatch(/WebVPN/)
  })

  /**
   * Mounted on the download page now, where none of home's `.stats` rules exist. Without its own
   * declarations it renders there as unstyled text: the same words, saying nothing at a glance.
   */
  it('brings its own colours rather than borrowing the library strip\'s', async () => {
    const on = await mount(reach())
    const off = await mount(reach({ port: null, listeners: [] }))
    const colour = (c: HTMLElement) => getComputedStyle(strong(c)!).color
    expect(colour(on.container)).not.toBe(colour(off.container))
  })

  /**
   * Found on screen, not by a test: on the library page the ⓘ sat sixty pixels to the right of the
   * word it explains, and nowhere else. `.stats svg` sizes the speed graph and matches this glyph
   * too, so the icon was drawn centred inside a 120px box. Declaring a width does not fix that,
   * because the min-width is what decides the box.
   */
  it('keeps the info glyph its own size inside a panel that stretches every svg', async () => {
    const { VpnStat } = await import('../../src/components/vpn-stat')
    const { container } = await render(<div css={strip}><VpnStat reachable={reach()}/></div>)
    const svg = container.querySelector('.stat.vpn .info svg')!
    expect(Math.round(svg.getBoundingClientRect().width)).toBeLessThan(20)
    // and it stays beside the word rather than drifting off across the strip
    const word = strong(container)!.getBoundingClientRect()
    expect(svg.getBoundingClientRect().left - word.right).toBeLessThan(12)
  })
})
