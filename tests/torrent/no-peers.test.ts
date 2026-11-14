// When a surface says a download found nobody: once the first search is over, and not before.
import { afterEach, describe, expect, it } from 'vitest'

import { startLanguage } from '../../src/i18n'
import de from '../../src/locales/de.json'
import { NO_PEERS_AFTER_MS, noPeersFound, noPeersLine } from '../../src/torrent/no-peers'

const NOW = 1_800_000_000_000

describe('whether a download has found nobody', () => {
  // the engine's own lifetimes (its README, Limits): a description read within 3 s, an offer nobody answered
  // closed after 50 s, an answered attempt given 30 s to open
  it('waits out the first round of offers, whatever happens to each', () => {
    expect(NO_PEERS_AFTER_MS).toBeGreaterThanOrEqual(3_000 + 50_000 + 30_000)
    // and says so before the next announce at the shortest interval a tracker may ask for would have ended, 60 s later
    expect(NO_PEERS_AFTER_MS).toBeLessThan(3_000 + 50_000 + 30_000 + 60_000)
  })

  it('is false until that long has passed, and true from then on', () => {
    expect(noPeersFound({ noPeersSince: NOW - NO_PEERS_AFTER_MS + 1 }, NOW)).toBe(false)
    expect(noPeersFound({ noPeersSince: NOW - NO_PEERS_AFTER_MS }, NOW)).toBe(true)
    expect(noPeersFound({ noPeersSince: NOW - 10 * NO_PEERS_AFTER_MS }, NOW)).toBe(true)
  })

  // the engine drops the field the moment a peer connects, and while a torrent is paused or done
  it('is false for a torrent the engine says nothing of', () => {
    expect(noPeersFound({}, NOW)).toBe(false)
    expect(noPeersFound(null, NOW)).toBe(false)
    expect(noPeersFound(undefined, NOW)).toBe(false)
    // a torrent added at the very start of the clock is not one with no time
    expect(noPeersFound({ noPeersSince: 0 }, NOW)).toBe(true)
  })
})

describe('the line that says it', () => {
  afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))

  it('says nobody was found and that the search goes on, naming the VPN only where it is off', () => {
    expect(noPeersLine('relay')).toBe('No peers found. Still searching.')
    expect(noPeersLine(null)).toBe('No peers found. Still searching.')
    expect(noPeersLine(undefined)).toBe('No peers found. Still searching.')
    expect(noPeersLine('direct')).toBe('No peers found with the VPN off. Still searching.')
  })

  it('follows the language of the page', async () => {
    await startLanguage({ language: 'de', languages: ['de-DE'], catalogues: { '../locales/de.json': async () => de } })
    expect(noPeersLine('relay')).toBe('Keine Peers gefunden. Die Suche läuft weiter.')
    expect(noPeersLine('direct')).toBe('Bei ausgeschaltetem VPN keine Peers gefunden. Die Suche läuft weiter.')
  })
})
