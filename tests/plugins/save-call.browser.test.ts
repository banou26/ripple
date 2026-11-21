// `save(infoHash, file?)` uses streamOnly: true, creates and cleans up a viewer id, routes single-file vs multi-file zip,
// and returns true on completion / false on cancellation.
import type { PluginTab } from '../../src/plugins/calls'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTorrentClient } from '../../src/torrent/client'
import { engineDouble, entry, snapshot } from './engine-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const saves = vi.hoisted(() => ({
  file: vi.fn(),
  zip: vi.fn(),
}))

vi.mock('idb-keyval', async () => {
  const made = (await import('./engine-double')).memoryStore()
  memory.store = made.store
  return made.module
})
vi.mock('../../src/torrent/save-file', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/torrent/save-file')>()
  return {
    ...real,
    saveTorrentFileToDisk: saves.file,
    saveTorrentEntriesAsZipToDisk: saves.zip,
  }
})

const { rippleFor } = await import('../../src/plugins/calls')
const { createFeed } = await import('../../src/plugins/feed')
const { answer } = await import('../../src/plugins/switches')

const URI = 'npm:@someone/save-plugin'
const SINGLE = '1'.repeat(40)
const MULTI = '2'.repeat(40)

describe('save() streamOnly routing and viewer lifecycle', () => {
  let feed: ReturnType<typeof createFeed>
  let engine: ReturnType<typeof engineDouble>
  let close: () => void
  let ripple: ReturnType<typeof rippleFor>['ripple']

  beforeEach(async () => {
    memory.store.clear()
    saves.file.mockReset().mockResolvedValue(undefined)
    saves.zip.mockReset().mockResolvedValue(undefined)
    engine = engineDouble({ createTorrentClient } as never)
    engine.start(
      [entry(SINGLE, { name: 'One' }), entry(MULTI, { name: 'Pack' })],
      [{ handle: 1, magnet: `magnet:?xt=urn:btih:${SINGLE}&dn=One` }, { handle: 2, magnet: `magnet:?xt=urn:btih:${MULTI}&dn=Pack` }],
    )
    engine.say({
      type: 'state',
      torrents: [
        { ...snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${SINGLE}&dn=One` }), files: { files: [{ path: 'only.mkv', size: 500, offset: 0, pad: false }] } },
        { ...snapshot({ handle: 2, magnet: `magnet:?xt=urn:btih:${MULTI}&dn=Pack` }), files: { files: [{ path: '.pad/16', size: 16, offset: 0, pad: true }, { path: 'a.mp4', size: 100, offset: 16, pad: false }, { path: 'b.mp4', size: 200, offset: 116, pad: false }] } },
      ],
    })
    feed = createFeed(engine.client)
    const tab: PluginTab = {
      client: () => engine.client, buttonsChanged: () => {}, openPage: async () => {}, beginClosePage: () => null, closePage: () => {},
      inGesture: () => true, takeSuggest: () => false, canSuggest: () => false, suggest: async () => ({ infoHash: null, outcome: 'failed' }),
      navigate: () => {}, folder: async () => null, feed: () => feed, owns: () => true, vpn: () => true,
      locale: () => ({ locale: 'en', dir: 'ltr' }), onActive: () => () => {}, onVpn: () => () => {}, onLocale: () => () => {},
    }
    ;({ ripple, close } = rippleFor(URI, tab, async () => ['files']))
    await answer(URI, { files: true })
  })

  afterEach(() => { close(); feed.destroy(); engine.client.destroy() })

  it('passes streamOnly: true and cleans up its viewer for single file, whole single-file torrent, and multi-file zip', async () => {
    expect(await ripple.save(MULTI, 1)).toBe(true)
    expect(saves.file).toHaveBeenCalledWith(engine.client, 2, 1, 'a.mp4', 100, undefined, expect.objectContaining({ streamOnly: true, viewer: expect.any(String) }))
    expect(engine.posted.filter((m) => m.type === 'unwatch')).toHaveLength(1)

    expect(await ripple.save(SINGLE)).toBe(true)
    expect(saves.file).toHaveBeenLastCalledWith(engine.client, 1, 0, 'only.mkv', 500, undefined, expect.objectContaining({ streamOnly: true }))

    expect(await ripple.save(MULTI)).toBe(true)
    expect(saves.zip).toHaveBeenCalledWith(
      engine.client, 2, 'Pack',
      [{ index: 1, path: 'a.mp4', size: 100 }, { index: 2, path: 'b.mp4', size: 200 }],
      undefined,
      expect.objectContaining({ streamOnly: true, viewer: expect.any(String) }),
    )
    expect(engine.posted.filter((m) => m.type === 'unwatch')).toHaveLength(3)

    saves.file.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
    expect(await ripple.save(SINGLE, 0)).toBe(false)
    expect(engine.posted.filter((m) => m.type === 'unwatch')).toHaveLength(4)
  })
})
