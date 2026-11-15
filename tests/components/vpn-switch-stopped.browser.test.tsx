import type { Reachability } from '../../src/torrent/client'

import { beforeEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { IntlRoot } from '../../src/i18n'

// The one constant that stops WebRTC peers also takes the switch away: what is left is the readout of before,
// and a choice stored while the switch was there reads as On.
const page = vi.hoisted(() => ({ setVpn: vi.fn() }))

vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: false,
}))
vi.mock('../../src/torrent/client', () => ({ setVpn: page.setVpn }))

beforeEach(() => { localStorage.clear() })

const ON = {
  listening: { tcp: '0.0.0.0:41337' }, listenFailed: [], inbound: 0, inboundByTransport: {}, lastInbound: null,
  port: 41337, listeners: [{ transport: 'tcp', port: 41337, up: true, healing: false, attempts: 0 }], portOpen: true,
} as Reachability

// the FKN quota used up, which offers nothing where there is no switch to press
const THROTTLED = {
  premium: false, overQuota: true, throttled: true, usedBytes: 5e9, limitBytes: 5e9, remainingBytes: 0,
  bytesPerSecond: 1_048_576, bitsPerSecond: 8_388_608,
}

const mount = async (reachable: Reachability | null) => {
  const { VpnSwitch } = await import('../../src/components/vpn-switch')
  return render(<IntlRoot><VpnSwitch reachable={reachable} transport="relay" quota={THROTTLED}/></IntlRoot>)
}

it('draws the state with nothing to press, and reads a stored Off as On', async () => {
  localStorage.setItem('ripple:vpn', 'off')
  const { container } = await mount(ON)
  expect(container.querySelector('[role="switch"]')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
  expect(container.querySelector('.track')).toBeNull()
  const stat = container.querySelector('.stat.vpn') as HTMLElement
  expect(stat.textContent).toBe('VPNOn')
  expect(stat.querySelector('strong')?.className).toContain('ok')
  stat.click()
  expect(page.setVpn).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(document.querySelector('.react-tooltip[role="status"]'), 'an offer to switch off a VPN that cannot be').toBeNull()
  expect(localStorage.getItem('ripple:vpn'), 'the choice is kept for when the switch is back').toBe('off')
})

/** nothing known yet is not the same as off, and saying off would invent a fault out of a gap */
it('draws nothing at all before the engine has said anything', async () => {
  const { container } = await mount(null)
  expect(container.querySelector('.stat.vpn')).toBeNull()
})
