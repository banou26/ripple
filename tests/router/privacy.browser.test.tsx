import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter } from 'react-router-dom'

import { ICE_SERVERS, STUN_HOST, TRACKERS, TRACKER_HOSTS, VPN_OFF_HOSTS } from '../../src/torrent/vpn-config'

/*
 * With the VPN off a person's IP address is seen by hosts FKN does not run, so the privacy page names each one,
 * and the legal page says where peer traffic goes in each mode. The list is the one the engine is handed: a host
 * added to it reaches the page with no edit, and a host written on the page that the code no longer reaches fails.
 */
const privacy = async () => {
  const { default: Privacy } = await import('../../src/router/privacy')
  return render(<MemoryRouter><Privacy/></MemoryRouter>)
}

/** Every host name a text holds: labels joined by dots, ending in letters. */
const hostsIn = (text: string) => text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g) ?? []

describe('the privacy page, with the VPN off', () => {
  it('names every host the browser reaches by itself, and no host besides', async () => {
    const screen = await privacy()
    const list = screen.getByTestId('vpn-off-hosts').element()
    for (const host of VPN_OFF_HOSTS) expect(list.textContent, host).toContain(host)
    expect(new Set(hostsIn(list.textContent))).toEqual(new Set(VPN_OFF_HOSTS))
  })

  // THE CONTROL: the list is the engine's own, so an empty one cannot pass the loop above for nothing
  it('reads the list the engine is handed: the two trackers and the STUN host', () => {
    expect(VPN_OFF_HOSTS).toEqual([...TRACKER_HOSTS, STUN_HOST])
    expect(TRACKERS.map((tracker) => new URL(tracker).hostname)).toEqual(TRACKER_HOSTS)
    expect(ICE_SERVERS.map(({ urls }) => urls.split(':')[1])).toEqual([STUN_HOST])
    expect(TRACKER_HOSTS.length).toBeGreaterThan(0)
    expect(hostsIn('ask tracker.example.org and stun.example.net, then fkn.app')).toEqual(['tracker.example.org', 'stun.example.net', 'fkn.app'])
  })

  it('says who sees the IP address: the peers, the trackers, the STUN host and the device\'s name server', async () => {
    const screen = await privacy()
    const seen = [...screen.getByTestId('vpn-off-hosts').element().querySelectorAll('li')].map((item) => item.textContent)
    expect(seen).toHaveLength(4)
    expect(seen[0]).toMatch(/^the other peers/)
    expect(seen[1]).toMatch(/^the trackers .*A tracker also sees which torrents/)
    expect(seen[2]).toMatch(new RegExp(`^${STUN_HOST.replaceAll('.', '\\.')}, which tells your browser its public address`))
    expect(seen[3]).toMatch(/^the name server your device uses/)
    expect(screen.container.textContent).toContain('With the VPN off, Ripple connects to peers straight from your browser, and nothing passes through the FKN relay. Your IP address is then seen by:')
  })

  it('says the relay hides the address only with the VPN on, and where the setting is kept', async () => {
    const screen = await privacy()
    const text = screen.container.textContent
    // the one paragraph that claims it starts by saying when it is true
    const claims = [...screen.container.querySelectorAll('p')].map((paragraph) => paragraph.textContent).filter((paragraph) => paragraph.includes('not yours'))
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatch(/^With the VPN on, which is how Ripple starts, connections to peers and to trackers are tunneled through the FKN relay rather than opened directly, so the other peers in a swarm and its trackers see the relay’s IP address, not yours\./)
    expect(text).toContain('The relay also looks up the names of trackers.')
    expect(text).toContain('whether the VPN is on')
    expect(text).toContain('The VPN setting is kept in your browser’s storage. A player embedded in another site keeps its own.')
  })
})

describe('the legal page', () => {
  it('says where peer traffic goes in each mode', async () => {
    const { default: Legal } = await import('../../src/router/legal')
    const { container } = await render(<MemoryRouter><Legal/></MemoryRouter>)
    expect(container.textContent).toContain('With the VPN on, peer traffic is forwarded through the FKN relay, which does not store content')
    expect(container.textContent).toContain('With the VPN off, peer traffic goes straight between your browser and the other peers and does not pass through FKN at all.')
    // no sentence is left that says it of every transfer
    expect(container.textContent).not.toMatch(/\. Peer traffic is forwarded through the FKN relay/)
  })
})
