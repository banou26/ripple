// What an embedder may ask of /watch: anything else posted to the window is not an ask.
import { expect, it } from 'vitest'

import { embedderAsk } from '../../src/router/embedder'

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10'

it('reads an open or a prepare, with or without a file', () => {
  expect(embedderAsk({ ripple: 'open', magnet: MAGNET, fileIndex: 3 })).toEqual({ ripple: 'open', magnet: MAGNET, fileIndex: 3 })
  expect(embedderAsk({ ripple: 'prepare', magnet: MAGNET })).toEqual({ ripple: 'prepare', magnet: MAGNET })
  expect(embedderAsk({ ripple: 'open', magnet: MAGNET, fileIndex: 0 })).toEqual({ ripple: 'open', magnet: MAGNET, fileIndex: 0 })
})

it('refuses anything else', () => {
  for (const data of [
    null, 'open', { ripple: 'opened', magnet: MAGNET }, { ripple: 'seek', magnet: MAGNET },
    { ripple: 'open' }, { ripple: 'open', magnet: 'https://example.com/a.torrent' },
    { ripple: 'open', magnet: MAGNET, fileIndex: -1 }, { ripple: 'open', magnet: MAGNET, fileIndex: 1.5 }, { ripple: 'open', magnet: MAGNET, fileIndex: '2' },
  ]) expect(embedderAsk(data), JSON.stringify(data)).toBeUndefined()
})
