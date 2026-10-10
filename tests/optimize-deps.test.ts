/**
 * Every dependency a browser test first meets mid run is pre-bundled up front.
 *
 * On a cold dependency cache, a bare import vite meets after its initial scan makes it re-optimize
 * and reload the page under the test runner, which then fails ("Vitest failed to find the runner")
 * or hangs. CI's cache is always cold. Two ways in, both measured 2026-10-04:
 *
 * - The engine worker a browser test starts, `src/torrent/worker.ts`, is the only importer of
 *   `@fkn/lib/net` and `@fkn/lib/dgram` ("dependencies optimized: @fkn/lib/dgram, @fkn/lib/net"),
 *   so every `@fkn/lib` entry point is checked.
 * - With no `build/` (CI, a fresh clone), the player's GET /build/libav-worker.js falls through to
 *   the SPA fallback, vite serves the root index.html and pre-transforms `/src/index.tsx`, and
 *   `src/router/index.tsx` is the only importer of `react-router` ("new dependencies found:
 *   react-router"). Two of five cold local runs without a build hung past 580 s on it, and the
 *   other three passed after the reload. A tree with a build never shows it, which is how it
 *   outlived the first fix.
 */
import viteConfig from '../vite.config.ts?raw'

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

/** Runtime imports; `import type` is erased and never reaches vite. */
const runtimeImports = (source: string): string[] =>
  [...source.matchAll(/^\s*import\s+(?!type\s)[^'"]*?['"]([^'"]+)['"]/gm)].map(match => match[1] ?? '')

const isFknLib = (specifier: string) => specifier === '@fkn/lib' || specifier.startsWith('@fkn/lib/')

/** The late entries that are not `@fkn/lib`, each with the one module that brings it in. */
const lateEntries: Record<string, string> = {
  '@banou/ponyfill': '../src/torrent/save-file.ts',
  'react-router': '../src/router/index.tsx',
}

const optimizeInclude = (config: string): string[] => {
  const block = /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(config)?.[1]
  if (!block) throw new Error('vite.config.ts has no optimizeDeps.include')
  const code = block.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
  return [...code.matchAll(/'([^']+)'/g)].map(match => match[1] ?? '')
}

describe('optimizeDeps.include covers every dependency a browser test meets late', () => {
  const fknEntries = [...new Set(Object.values(sources).flatMap(runtimeImports).filter(isFknLib))].sort()
  const included = optimizeInclude(viteConfig)

  it('the scans find what they must (control)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
    expect(fknEntries).toEqual(expect.arrayContaining(['@fkn/lib', '@fkn/lib/net', '@fkn/lib/dgram']))
    expect(included).toContain('@fkn/lib')
    expect(runtimeImports("import type { Frame } from '@fkn/lib/types'")).toEqual([])
    for (const [specifier, importer] of Object.entries(lateEntries)) {
      expect(runtimeImports(sources[importer] ?? ''), importer).toContain(specifier)
    }
  })

  it('lists each @fkn/lib entry point', () => {
    expect(fknEntries.filter(specifier => !included.includes(specifier))).toEqual([])
  })

  it('lists each late entry, so a cold cache never reloads a browser test mid run', () => {
    expect(Object.keys(lateEntries).filter(specifier => !included.includes(specifier))).toEqual([])
  })
})
