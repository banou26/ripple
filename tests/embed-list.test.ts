import { describe, expect, it } from 'vitest'

import pkg from '../package.json'
import FILE from '../src/.well-known/fkn.json?raw'

/**
 * The owner, 2026-11-20 (typos fixed): "Wait no, I want anyone to be able to embed Ripple." fkn.app's parser is strict
 * (HOR-1183): `v: 1`, nothing it does not know, and `"*"` alone for every app, so a typo here reads as no file and
 * every app is refused. This pins the file to the one spelling, and the build to the path fkn.app reads.
 */
describe('the embed list', () => {
  it('lets every app embed the site, in the one spelling fkn.app reads', () => {
    expect(JSON.parse(FILE)).toStrictEqual({ v: 1, embed: ['*'] })
  })

  it('is copied to the path fkn.app reads, in every build', () => {
    expect(pkg.scripts['copy-html']).toContain('shx cp src/.well-known/fkn.json build/.well-known/fkn.json')
    expect(pkg.scripts.build).toContain('npm run copy-html')
  })
})
