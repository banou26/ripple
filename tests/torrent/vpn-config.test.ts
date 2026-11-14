// The hosts the browser reaches by itself with the VPN off: the owner's two trackers and one STUN host, and a list
// of them that cannot name fewer than the engine is handed.
import { expect, it } from 'vitest'

import { ICE_SERVERS, TRACKERS, VPN_OFF_HOSTS } from '../../src/torrent/vpn-config'

it('announces to the two trackers and asks the one STUN host the owner chose', () => {
  expect(TRACKERS).toEqual(['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'])
  expect(ICE_SERVERS).toEqual([{ urls: 'stun:stun.l.google.com:19302' }])
})

it('lists the host of every tracker and STUN server, and nothing else', () => {
  const hosts = [
    ...TRACKERS.map((url) => new URL(url).hostname),
    ...ICE_SERVERS.map(({ urls }) => /^stun:([^:]+):\d+$/.exec(urls)?.[1]),
  ]
  expect(hosts).toHaveLength(3)
  expect(VPN_OFF_HOSTS).toEqual(hosts)
})
