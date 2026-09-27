/**
 * Every spec that hands the app a real FileSystemHandle runs in a regular profile.
 *
 * A picker stubbed with a real handle means the app stores that handle in IndexedDB and reads it
 * back, and on Chrome 153 that crashes the browser in Playwright's stock off-the-record context (see
 * regular-profile.ts). CI's bundled Chromium does not have the bug, so nothing there would notice a
 * spec going back to the stock `test`: it would only go red on a machine running 153, looking like
 * an app bug. This is the check that runs everywhere.
 */
import { describe, expect, it } from 'vitest'

const specs = import.meta.glob('./*.spec.ts', { query: '?raw', import: 'default', eager: true })
const fixture = import.meta.glob('./regular-profile.ts', { query: '?raw', import: 'default', eager: true })

// an assignment, not a `delete`: the specs that delete the pickers never hand over a handle
const STUBS_A_PICKER = /\.(showDirectoryPicker|showOpenFilePicker)\s*=(?!=)/
const STOCK_TEST = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'@playwright\/test'/
const REGULAR_TEST = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'\.\/regular-profile'/

const stubbing = Object.keys(specs).filter((path) => STUBS_A_PICKER.test(specs[path]!)).sort()

describe('specs that store a FileSystemHandle', () => {
  it('are found, so the rule below cannot pass on an empty list', () => {
    expect(stubbing).toEqual(expect.arrayContaining([
      './create-torrent.spec.ts',
      './hybrid-torrent.spec.ts',
      './one-file-torrent.spec.ts',
      './uptime-persists.spec.ts',
    ]))
  })

  it('take `test` from regular-profile, never the stock off-the-record context', () => {
    const stock = stubbing.filter((path) => STOCK_TEST.test(specs[path]!) || !REGULAR_TEST.test(specs[path]!))
    expect(stock, 'these store a handle in a context where Chrome 153 crashes reading it back').toEqual([])
  })

  it('get a persistent profile from that fixture', () => {
    expect(fixture['./regular-profile.ts'], 'regular-profile.ts no longer launches a persistent context')
      .toMatch(/\.launchPersistentContext\(/)
  })
})
