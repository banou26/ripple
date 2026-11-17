// The page the build ships and the dev server's entry set one referrer policy, ahead of anything they load: smoke.spec.ts
// measures it on the build alone, and a dev run without it sends a link's query back in every same-origin Referer.
import shipped from '../src/index.html?raw'
import dev from '../index.html?raw'

import { expect, test } from 'vitest'

const META = '<meta name="referrer" content="strict-origin" />'

test.each([['src/index.html', shipped], ['index.html', dev]])('%s sets the referrer policy before it loads anything', (_, html) => {
  const at = html.indexOf(META)
  expect(at).toBeGreaterThan(-1)
  for (const tag of ['<link', '<script']) expect(html.indexOf(tag), tag).toBeGreaterThan(at)
})
