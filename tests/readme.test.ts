// What the README says of the VPN follows the code: it names no host of its own, and says the address is seen with the VPN off.
import readme from '../README.md?raw'

import { expect, it } from 'vitest'

import { VPN_OFF_HOSTS } from '../src/torrent/vpn-config'

it('says peers see the relay\'s address only with the VPN on, and leaves the hosts to the privacy page', () => {
  expect(readme).toContain('Peers and trackers see the FKN relay\'s address, not yours, unless\nyou turn the VPN off')
  expect(readme).not.toMatch(/Peers see the FKN relay's address, not yours\./)
  expect(readme).toContain('names\neach of those hosts (`src/router/privacy.tsx`)')
  // a host written here would fall behind the list the engine is handed
  expect(VPN_OFF_HOSTS.filter((host) => readme.includes(host))).toEqual([])
})

it('says the .torrent files sync with the list and the thumbnails', () => {
  expect(readme).toContain('Signed in to FKN, your list, thumbnails and .torrent files sync to your account,\nencrypted in your browser first.')
})
