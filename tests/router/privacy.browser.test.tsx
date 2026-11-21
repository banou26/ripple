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

describe('the privacy page, signed in', () => {
  it('says each torrent\'s .torrent file syncs with its tracker addresses, and goes with the torrent\'s removal', async () => {
    const screen = await privacy()
    const text = screen.container.textContent
    expect(text).toContain('Each torrent’s .torrent file syncs too, with its tracker addresses.')
    expect(text).toContain('deletes its synced thumbnail and .torrent file;')
    expect(text).toContain('each torrent’s resume data, .torrent file and thumbnail')
  })
})

describe('the privacy page, on groups', () => {
  it('says the groups are kept in the browser and synced to the account, and what of them', async () => {
    const screen = await privacy()
    const paragraphs = [...screen.container.querySelectorAll('p')].map((paragraph) => paragraph.textContent)
    const onDevice = paragraphs.find((p) => p.startsWith('Your torrent list'))
    expect(onDevice).toMatch(/^Your torrent list and its groups, each torrent’s resume data/)
    expect(onDevice).toContain('Ripple also remembers which FKN account your list and groups belong to.')
    const synced = paragraphs.find((p) => p.startsWith('If you connect an FKN account'))
    expect(synced).toContain('your groups (each group’s name, and which torrents were put in it or taken out and when)')
    const control = paragraphs.find((p) => p.startsWith('Ripple itself has no account to delete'))
    expect(control).toContain('it stays in the groups it was in until you delete them')
  })

  it('says what a group\'s link holds, that no server receives it, and that private torrents stay out of it', async () => {
    const screen = await privacy()
    const heading = [...screen.container.querySelectorAll('h2')].find((h) => h.textContent === 'Group links')
    const text = heading?.nextElementSibling?.textContent?.replace(/\s+/g, ' ')
    expect(text).toContain('A group’s link holds the group’s name and, for each of its torrents, its magnet link without its name: the info hash, trackers, web seeds and any other part of it.')
    expect(text).toContain('a part browsers never send to a server, so opening the link shows the server a visit to /add and nothing of the group')
    expect(text).toContain('A torrent added on this device from a .torrent file marked private is left out.')
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

/*
 * RIPPLE-1's words, as the owner approved them on 2026-11-20: plugins can add torrents, so the legal page no longer
 * says every torrent is the person's own, and the privacy page says what a plugin can see while it is switched on.
 * Slice 1's privacy words only: reading files, the folder, removing and peers come with the switches that reach them.
 */
const sectionOf = (container: HTMLElement, heading: string) => {
  const h2 = [...container.querySelectorAll('h2')].find((h) => h.textContent === heading)
  const paragraphs: string[] = []
  for (let next = h2?.nextElementSibling; next && next.tagName === 'P'; next = next.nextElementSibling) paragraphs.push(next.textContent.replace(/\s+/g, ' ').trim())
  return paragraphs
}

describe('the legal page, on plugins', () => {
  it('says ripple keeps no catalog of its own, plugins are others\' work, and a concern about one goes to its publisher', async () => {
    const { default: Legal } = await import('../../src/router/legal')
    const { container } = await render(<MemoryRouter><Legal/></MemoryRouter>)
    expect(sectionOf(container, 'No hosted content')).toEqual([
      'Ripple hosts no torrents and no media. It has no search, no index, no tracker, and no catalog of its own. You supply the magnet links and .torrent files yourself, or through a plugin you added, and transfers happen between your browser and the other peers in each torrent’s swarm. Downloaded data is stored only in your browser’s storage, on your device.',
    ])
    expect(sectionOf(container, 'Plugins')).toEqual([
      'You can add plugins to Ripple. The plugins in FKN’s package list, which shows packages published on npm, are published by others: Ripple and FKN do not write, review or endorse them, and are not responsible for what a plugin shows, finds, adds or does. Ripple keeps no list of its own. A plugin can use only what you turn on for it in Settings, and you can turn any of that off, or remove the plugin, at any time. You are responsible for the plugins you add and for the torrents they add for you, as for the ones you add yourself.',
    ])
    expect(sectionOf(container, 'Rights holders')[0]).toContain('does not pass through FKN at all. A plugin that finds or adds torrents is published by its own publisher and runs in your browser, apart from Ripple. A concern about a plugin goes to its publisher. If you have a concern about the relay itself, contact admin@fkn.app.')
    expect(container.textContent, 'the optional sentence the owner left out').not.toContain('switch a plugin off')
    expect(container.querySelector('.updated')).toHaveTextContent('Last updated 21 November 2026')
  })
})

describe('the privacy page, on plugins', () => {
  it('says what a plugin can see once switched on, that the VPN rule is the plugin\'s to keep, and what is kept where', async () => {
    const screen = await privacy()
    const { container } = screen
    expect(sectionOf(container, 'Plugins')).toEqual([
      'A plugin you add runs apart from Ripple and can use only what you turned on for it in Settings. Depending on that, it can see your torrent list, add torrents, pause, change or group them, add trackers to them (which tells those trackers about the torrent), and see your connection status. A plugin can send what it sees to its publisher or to any site. Ripple hands it nothing of your FKN account, never the keys in private trackers’ addresses, and nothing of other plugins.',
      'A plugin makes its own requests to the sites it uses. Ripple tells each plugin whether the VPN is on, and plugins must send their requests through the FKN relay while it is. Ripple cannot check that a plugin does, so a plugin may show your IP address to the sites it reaches. Torrents a plugin adds download like your own, through the relay while the VPN is on, and count toward your daily FKN quota.',
      'On this device, FKN keeps which plugins you added, and Ripple keeps what you turned on for each one and the data each plugin asks it to keep. Removing a plugin in Settings deletes all of it; the torrents it added stay in your list. What a plugin keeps elsewhere is up to its publisher.',
    ])
    const text = container.textContent.replace(/\s+/g, ' ')
    expect(text).toContain('neither Ripple nor FKN stores anything about you on a server. A plugin you add may, as its publisher decides.')
    expect(text).toContain('removes everything Ripple stored in your browser. The plugins you added are kept by FKN on this device, so remove them in Settings first.')
    for (const later of ['read and play your downloaded files', 'move them to and from your folder', 'remove torrents', 'addresses of the peers']) {
      expect(text, `slice 3's words wait for slice 3: ${later}`).not.toContain(later)
    }
    expect(container.querySelector('.updated')).toHaveTextContent('Last updated 21 November 2026')
  })
})
