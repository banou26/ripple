import { describe, expect, test } from 'vitest'

import { catalogues, english } from '../languages'

const PLACEHOLDER = 'Add a magnet link, or drop a .torrent'

// the check asks this only of a language once it is offered, by when a gap would already be someone else's to find
describe('every catalogue', () => {
  const code = Object.keys(english())

  test.each(Object.entries(catalogues()))('%s carries every message of the code', (_, catalogue) => {
    expect(code.filter(id => !Object.hasOwn(catalogue, id))).toEqual([])
  })

  // a field cannot wrap, and a phone leaves the English's own length to it
  test.each(Object.entries(catalogues()))('%s words the magnet field no longer than English', (_, catalogue) => {
    expect(catalogue[PLACEHOLDER]!.length).toBeLessThanOrEqual(PLACEHOLDER.length)
  })
})
