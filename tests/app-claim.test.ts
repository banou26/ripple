import pkg from '../package.json'
import { npmManifest } from '../scripts/write-npm-manifest.mjs'

import { expect, it } from 'vitest'

// ripple is a MANAGED app since 2026-09-23 (HOR-224 slice 6): it holds no key, and its npm source is
// claimed by this field, which the api reads from registry.npmjs.org/@banou%2fripple/latest and
// compares with EXACT equality. A wrong id reads as another app's claim, and a missing one leaves the
// source pending with every gate green, so both are pinned here rather than noticed at Check now.

// the id fkn.dev minted for Ripple on 2026-09-24, founder-derived so it can sign; its website, torrent.fkn.app,
// claims the same one by TXT record
const APP = 'fkn:app:1c7clnsv53zt7dr7q7rcbt455hxauykaxl4gibkuoao24dfmk2eqq'
// the founderless managed app it replaced, stopped 2026-09-24 because nothing could ever sign for it
const RETIRED = 'fkn:app:135yqk2jyumik36avcubguntimr6s4jbllsijxbyvbntjpj7sbt6a'
const ADDRESS = 'https://torrent.fkn.app/'

// since HOR-233 slice 9 every release is signed IN PLACE: `signed: true` is what makes a device ask
// unpkg for the release's fkn.json, and without it a signed package runs unchecked on every device
// that holds no list for Ripple
// it also names ripple's own address and its store images, which the api's claim reader ignores (it reads `app` and
// `signed` only)
const CLAIM = {
  app: APP,
  signed: true,
  url: ADDRESS,
  background: expect.any(String),
  cover: expect.any(String),
  screenshots: expect.any(Array),
  // relay sockets are checked against `<all_urls>` and BitTorrent reaches any tracker or peer, so the person allows
  // it on the card before launch, never mid-session
  network: ['<all_urls>'],
  // every app may add the package; fkn.app reads this list off the signed package.json, and @fkn/sign 0.0.16 is the
  // first to check it
  embed: ['*'],
}

it('claims the managed Ripple app, signed, with its address, store images, network and embed lists, and nothing else', () => {
  expect(pkg.name).toBe('@banou/ripple')
  // the whole object, so a reserved key riding along is caught too; store-listing.test.ts checks the images
  expect(pkg.fkn).toEqual(CLAIM)
})

it('the claim is a managed app id, and not the retired signed one', () => {
  expect(APP).toMatch(/^fkn:app:1[a-z2-7]{52}$/)
  expect(APP).not.toBe(RETIRED)
})

// `npm publish ./build` sends the FILTERED manifest, not this one, and that filter once dropped the
// field without a word (fixed in 7d5b0cf). So the claim is checked where the registry will read it.
it('the manifest that is actually published carries the whole claim, network and embed lists included', () => {
  expect(npmManifest(pkg).fkn).toEqual(CLAIM)
  // build/package.json names no files, so the fkn.json CI writes into build/ ships with the rest
  expect(npmManifest(pkg)).not.toHaveProperty('files')
})
