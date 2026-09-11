/**
 * The app's identity, checked with the platform's own verifier rather than by reading fields.
 *
 * `fkn.json` is what makes ripple a known app rather than an anonymous package: the platform fetches
 * it at the package root and a host serves it from `/.well-known/`. Its absence is SWALLOWED
 * (`recordManifest(...).catch(() => {})` in fkn-client, web/src/sources/npm.ts), so a manifest that
 * stops verifying, or that stops naming a source, costs the app its identity with nothing anywhere
 * saying so. 0.0.8 ran unregistered for exactly that reason, and the only symptom was a 404 in a
 * console.
 *
 * A signature that verifies says nothing about the SOURCE LIST being right, which is why both
 * sources are asked for by name.
 */
import { verifyManifest } from '@fkn/sign'

import { describe, expect, it } from 'vitest'

import keys from '../keys.json'
import pkg from '../package.json'
import manifest from '../fkn.json'

const raw = JSON.stringify(manifest)
const now = () => Math.floor(Date.now() / 1000)

describe('the signed manifest that ships with every copy', () => {
  it('verifies for the npm source, which is how fkn.app loads ripple', () => {
    const verdict = verifyManifest(raw, { now: now(), source: `npm:${pkg.name}` })
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ app: keys.app })
  })

  it('verifies for the site, which is how torrent.fkn.app serves it', () => {
    expect(verifyManifest(raw, { now: now(), source: 'https:torrent.fkn.app' })).toMatchObject({ app: keys.app })
  })

  it('is refused for a source it does not name, so the check can tell them apart', () => {
    const verdict = verifyManifest(raw, { now: now(), source: 'npm:@banou/stub' })
    expect(verdict).toMatchObject({ ok: false, code: 'SOURCE_NOT_LISTED' })
  })

  it('is signed by a key the committed list carries, under this repo\'s own app id', () => {
    expect(manifest.app).toBe(keys.app)
    expect(manifest.root).toBe(keys.root)
    expect(manifest.slug).toBe('ripple')
    expect(keys.keys.members).toContain(manifest.key)
  })

  it('is not dated in the future, which every verifier refuses', () => {
    // a re-sign on a machine with a skewed clock ships a manifest nothing will accept
    expect(manifest.issuedAt).toBeLessThanOrEqual(now() + 300)
  })
})
