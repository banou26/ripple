// The page the build ships and the dev server serves sets the referrer policy ahead of anything it loads: smoke.spec.ts
// measures it on the build alone, and a dev run without it sends a link's query back in every same-origin Referer.
import page from '../index.html?raw'

import { expect, test } from 'vitest'

const META = '<meta name="referrer" content="strict-origin" />'

test('index.html sets the referrer policy before it loads anything', () => {
  const at = page.indexOf(META)
  expect(at).toBeGreaterThan(-1)
  for (const tag of ['<link', '<script']) expect(page.indexOf(tag), tag).toBeGreaterThan(at)
})
