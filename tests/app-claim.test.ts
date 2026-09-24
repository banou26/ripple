// read through vite rather than node:fs, for the reason lanes.test.ts records
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

// since HOR-233 slice 9 every release is signed IN PLACE: `signed: true` is what makes a device ask
// unpkg for the release's fkn.json, and without it a signed package runs unchecked on every device
// that holds no list for Ripple
it('claims the managed Ripple app and says its releases are signed, and nothing else', () => {
  expect(pkg.name).toBe('@banou/ripple')
  // the whole object, so a reserved key riding along is caught too
  expect(pkg.fkn).toEqual({ app: APP, signed: true })
})

it('the claim is a managed app id, and not the retired signed one', () => {
  expect(APP).toMatch(/^fkn:app:1[a-z2-7]{52}$/)
  expect(APP).not.toBe(RETIRED)
})

// `npm publish ./build` sends the FILTERED manifest, not this one, and that filter once dropped the
// field without a word (fixed in ea36446). So the claim is checked where the registry will read it.
it('the manifest that is actually published carries the claim and the flag', () => {
  expect(npmManifest(pkg).fkn).toEqual({ app: APP, signed: true })
  // build/package.json names no files, so the fkn.json CI writes into build/ ships with the rest
  expect(npmManifest(pkg)).not.toHaveProperty('files')
})
