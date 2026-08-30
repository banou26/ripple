import type { Reachability } from '../torrent/client'

import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * The inbound stat, and specifically its tolerance of an engine older than itself.
 *
 * A deploy is not atomic and a browser tab is not a single version. The page can be the new build
 * while the engine chunk behind it is the one the service worker already had, and `engine-share`
 * hands a tab state produced by whichever OTHER tab owns the engine, which during a rollout is
 * routinely the old one. So this component receives a `Reachability` from a version it was not
 * compiled against, and has to render anyway.
 *
 * It did not. `listeners.some(...)` on a pre-0.3.13 payload threw
 * `Cannot read properties of undefined (reading 'some')`, and because a stat strip is rendered
 * inside the route, that took the entire page down to React Router's error screen. Caught on
 * torrent.fkn.app immediately after the deploy on 2026-08-16.
 */

const legacy = (over: Partial<Reachability> = {}) => ({
  // exactly the shape an engine before 0.3.13 sends: no `listeners`, no `portOpen`
  listening: { tcp: '0.0.0.0:41337' },
  listenFailed: [],
  inbound: 3,
  inboundByTransport: { utp: 2, tcp: 1 },
  lastInbound: null,
  port: 41337,
  ...over,
}) as Reachability

const current = (over: Partial<Reachability> = {}): Reachability => ({
  ...legacy(),
  listeners: [{ transport: 'udp', port: 41337, up: true, healing: false, attempts: 0 }],
  portOpen: true,
  ...over,
})

const mount = async (reachable: Reachability | null) => {
  const { ConnectionStat } = await import('./home')
  return render(<ConnectionStat reachable={reachable}/>)
}

const text = (screen: Awaited<ReturnType<typeof mount>>) =>
  screen.container.querySelector('.stat strong')?.textContent

describe('the inbound stat', () => {
  describe('against an engine that predates it', () => {
    it('renders instead of throwing', async () => {
      const screen = await mount(legacy())
      expect(screen.container.querySelector('.stat')).not.toBeNull()
    })

    /**
     * `portOpen` defaults to true, not false. An old engine cannot tell us whether the port is
     * still held, and reporting "closed" would be inventing a fault out of a missing field, which
     * is the same sin as the stale readout this whole feature was built to remove.
     */
    it('does not invent a fault out of a field the engine never sent', async () => {
      const screen = await mount(legacy())
      expect(text(screen)).not.toContain('closed')
      expect(text(screen)).not.toContain('reconnecting')
      expect(text(screen)).toContain(':41337')
    })

    it('still shows a listen failure, which every version has always sent', async () => {
      const screen = await mount(legacy({ listenFailed: ['listening on 0.0.0.0:41337 failed: nope'] }))
      expect(text(screen)).toBe('Failed')
    })
  })

  describe('against a current engine', () => {
    it('names the port and how many have dialled in', async () => {
      const screen = await mount(current())
      expect(text(screen)).toBe(':41337 · 3 dialled in')
    })

    /**
     * The bug this wording exists for. It read `41337 · 2 utp · 1 tcp`, which was taken for a live
     * peer count and reported as wrong against a torrent connected to one peer. `inbound` is every
     * connection accepted since the session started, so the strip has to say so in words and leave
     * the transport split to the tooltip.
     */
    it('never puts a bare transport split on the strip, which reads as a peer count', async () => {
      const screen = await mount(current())
      expect(text(screen)).not.toMatch(/\d+ utp/)
      expect(text(screen)).not.toMatch(/\d+ tcp/)
    })

    it('keeps the split, and says it is a running total, in the tooltip', async () => {
      const screen = await mount(current())
      const title = screen.container.querySelector('.stat')?.getAttribute('title') ?? ''
      expect(title).toContain('2 utp')
      expect(title).toContain('1 tcp')
      expect(title).toMatch(/running total, not how many peers are connected now/)
    })

    it('writes the port the way a port is written', async () => {
      const screen = await mount(current())
      expect(text(screen)).toMatch(/^:41337/)
    })

    it('says the port is being reclaimed while its socket heals', async () => {
      const screen = await mount(current({
        portOpen: false,
        listeners: [{ transport: 'udp', port: 41337, up: false, healing: true, attempts: 1 }],
      }))
      expect(text(screen)).toBe(':41337 · reconnecting')
    })

    /** Healed onto a different number: nothing is in an error state and the announce is now wrong. */
    it('says the port is closed once the acceptor has moved off it', async () => {
      const screen = await mount(current({
        portOpen: false,
        listeners: [{ transport: 'udp', port: 45678, up: true, healing: false, attempts: 3 }],
      }))
      expect(text(screen)).toBe(':41337 · closed')
    })

    it('shows nothing at all before the first reading', async () => {
      const screen = await mount(null)
      expect(screen.container.querySelector('.stat')).toBeNull()
    })

    it('says unreachable when no port was ever reserved', async () => {
      const screen = await mount(current({ port: null, portOpen: false, listeners: [] }))
      expect(text(screen)).toBe('Unreachable')
    })
  })
})
