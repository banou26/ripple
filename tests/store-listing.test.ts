import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

// fkn.app's package page shows the images package.json's fkn field names, read from the published package, which
// is build/ (`npm publish ./build`), so the build copies store/ into it and check-npm-package.mjs refuses a build
// that lacks one. The caps are @fkn/package-manifest's LISTING_IMAGE_MAX_BYTES, LISTING_IMAGE_MAX_SIDE and
// SCREENSHOTS_MAX, copied because ripple does not depend on that package; fkn-sign refuses a release past them.
const MAX_BYTES = 1_048_576
const MAX_SIDE = 3_840
const SCREENSHOTS_MAX = 6

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

const pkg = JSON.parse(readFileSync(root('package.json'), 'utf-8')) as {
  scripts: Record<string, string>
  fkn: { background: string, cover: string, screenshots: string[] }
}
const { background, cover, screenshots } = pkg.fkn
const named = [background, cover, ...screenshots]

// RIFF, a length, WEBP, then a lossy VP8 chunk whose frame header holds 14 bit width and height
const webpSizeOf = (path: string) => {
  const bytes = readFileSync(root(path))
  expect(bytes.subarray(0, 4).toString('latin1'), path).toBe('RIFF')
  expect(bytes.subarray(8, 12).toString('latin1'), path).toBe('WEBP')
  expect(bytes.subarray(12, 16).toString('latin1'), `${path} is not a simple lossy WebP: re-encode it with cwebp -q`).toBe('VP8 ')
  return { bytes: bytes.length, size: `${bytes.readUInt16LE(26) & 0x3fff}x${bytes.readUInt16LE(28) & 0x3fff}` }
}

describe("ripple's store listing", () => {
  test('names a background, a cover and one to six screenshots, each a WebP under store/ that the build ships', () => {
    expect(screenshots.length).toBeGreaterThanOrEqual(1)
    expect(screenshots.length).toBeLessThanOrEqual(SCREENSHOTS_MAX)
    expect(new Set(named).size).toBe(named.length)
    for (const path of named) expect(path).toMatch(/^store\/[a-z0-9-]+\.webp$/)
    expect(pkg.scripts['copy-html']).toContain('shx cp -r store build/store')
  })

  // what is in store/ ships whether or not the listing names it, and a named file missing from it fails the build
  test('holds exactly the images the listing names, none missing and none extra', () => {
    expect(readdirSync(root('store')).map(name => `store/${name}`).sort()).toEqual([...named].sort())
  })

  test('keeps every image within the caps fkn.app and the signer hold it to', () => {
    for (const path of named) {
      const { bytes, size } = webpSizeOf(path)
      expect(bytes, path).toBeLessThanOrEqual(MAX_BYTES)
      for (const side of size.split('x').map(Number)) expect(side, path).toBeLessThanOrEqual(MAX_SIDE)
    }
  })

  // the background is Steam's library hero size and the cover its 2:3 capsule; the screenshots are the built app at
  // 2560x1440 at 1.5 (scripts/store-art.mjs), a phone's at its 390x844 CSS size at 3
  test('draws each image at the size it was made for', () => {
    expect(webpSizeOf(background).size).toBe('3840x1240')
    expect(webpSizeOf(cover).size).toBe('600x900')
    for (const path of screenshots) expect(webpSizeOf(path).size, path).toBe(path.startsWith('store/phone') ? '1170x2532' : '3840x2160')
  })
})
