import pkg from '../package.json'
import { npmManifest } from '../scripts/write-npm-manifest.mjs'

import { expect, it } from 'vitest'

const ADDRESS = 'https://torrent.fkn.app/'

// HOR-226: fkn.app sends a top-level visit of /app/npm:@banou/ripple to this address once it is a verified
// source of ripple's app; @fkn/sign refuses any spelling other than the one the URL parser writes
it('the release declares torrent.fkn.app as ripple\'s own address, spelled as the URL parser writes it', () => {
  expect(pkg.fkn.url).toBe(ADDRESS)
  expect(new URL(pkg.fkn.url).href).toBe(pkg.fkn.url)
})

// CI signs ./build, so the address has to survive the filter that writes build/package.json
it('the manifest that is signed and published carries the address', () => {
  expect(npmManifest(pkg).fkn.url).toBe(ADDRESS)
})
