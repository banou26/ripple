import type { Reachability } from '../torrent/client'

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
}) as Reachability

const mount = async (reachable: Reachability | null) => {
  const { VpnStat } = await import('./home')
  return render(<VpnStat reachable={reachable}/>)
}

const strong = (c: HTMLElement) => c.querySelector('strong')

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
    expect(container.querySelector('.stat.vpn')?.getAttribute('title')).toMatch(/Loading torrent/)
  })
})
