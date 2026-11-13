import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const literal = /const PRODUCTION_ORIGIN = \/(.+)\/\n/.exec(readFileSync('scripts/rig-prepare.mjs', 'utf8'))?.[1]

describe('rig-prepare', () => {
  it('refuses a build that names a production origin, and passes one that only links the site', () => {
    expect(literal, 'the script no longer declares PRODUCTION_ORIGIN as one regex literal').toBeDefined()
    const production = new RegExp(literal ?? '')
    for (const named of ['https://fkn.app/api.html', 'wss://cz-prg-001.fkn.app/', 'https://api.fkn.app/graphql']) {
      expect(production.test(named), named).toBe(true)
    }
    for (const fine of ['https://www.fkn.app/how-it-works#webvpn', 'http://127.0.0.1:5234/api.html']) {
      expect(production.test(fine), fine).toBe(false)
    }
  })
})
