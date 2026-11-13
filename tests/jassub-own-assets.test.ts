import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import jassubOwnAssets from '../vite-plugin-jassub-own-assets.mjs'

/**
 * Every url jassub resolves for itself is a file the app build would pull in, and under `build.lib` inline as base64,
 * while ripple passes all of them explicitly. The plugin's own check only notices a replacement that stopped
 * matching, not a default a jassub upgrade added, which is how 2.5.35's two wasm scripts would have slipped in.
 */
const JASSUB = readFileSync(new URL('../node_modules/jassub/dist/jassub.js', import.meta.url), 'utf8')

const transform = (code: string) => {
  const plugin = jassubOwnAssets() as { transform: (this: unknown, code: string, id: string) => { code: string } | null }
  return plugin.transform.call({ error: (message: string) => { throw new Error(message) } }, code, '/app/node_modules/jassub/dist/jassub.js')
}

describe('the app build', () => {
  it('keeps none of the urls jassub resolves for itself', () => {
    expect(JASSUB.match(/import\.meta\.url/g)?.length, 'control: jassub resolves its defaults this way').toBeGreaterThan(0)
    expect(transform(JASSUB)!.code).not.toContain('import.meta.url')
  })
})
