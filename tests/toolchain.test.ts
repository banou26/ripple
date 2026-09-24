// read through vite rather than node:fs, for the reason lanes.test.ts records
import pkg from '../package.json'
import LOCK from '../package-lock.json?raw'
import NODE_VERSION from '../.node-version?raw'

import { describe, expect, it } from 'vitest'

// vite-plus bundles its own vitest and ships vite as vite-plus-core, and its docs require a project to
// pin both to the same release ("Updating the Vitest Pin" at viteplus.dev). A pin left behind on a
// vite-plus bump keeps installing the previous runner. Ripple had no vitest pin at all and carried the
// vulnerable vitest 4.1.10 (GHSA-82fw-gwwq-j7x9) under vite-plus 0.2.4 until 2026-09-24.
type LockEntry = { name?: string, version: string, dependencies?: Record<string, string>, engines?: { node?: string } }
type Manifest = { devDependencies: Record<string, string>, overrides: Record<string, string> }

const manifest: Manifest = pkg
const lock = JSON.parse(LOCK) as { packages: Record<string, LockEntry> }

const entry = (path: string): LockEntry => {
  const found = lock.packages[path]
  if (!found) throw new Error(`package-lock.json installs no ${path}`)
  return found
}

const installed = (pattern: RegExp): [string, LockEntry][] =>
  Object.entries(lock.packages).filter(([path]) => pattern.test(path))

describe('the vite-plus toolchain is pinned as one release', () => {
  const vitePlus = entry('node_modules/vite-plus')
  const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`

  it('the vite alias names the core of the installed vite-plus, everywhere npm reads it', () => {
    expect(manifest.devDependencies['vite-plus']).toBe(vitePlus.version)
    expect(manifest.devDependencies.vite).toBe(core)
    expect(manifest.overrides.vite).toBe(core)
    const vites = installed(/(^|\/)node_modules\/vite$/).map(([, found]) => `${found.name}@${found.version}`)
    expect(vites).toEqual([`@voidzero-dev/vite-plus-core@${vitePlus.version}`])
  })

  it('the vitest pin is the vitest vite-plus itself depends on', () => {
    expect(vitePlus.dependencies?.vitest).toBeDefined()
    expect(manifest.overrides.vitest).toBe(vitePlus.dependencies?.vitest)
  })

  // the override reaches vitest only; @vitest/browser-playwright is a direct dependency with exact
  // dependencies of its own, so a range there can pull a second @vitest/browser beside the bundled one
  it('a direct @vitest dependency names the pin exactly', () => {
    const direct = Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith('@vitest/'))
    expect(direct.length, 'no direct @vitest dependency left, so this proves nothing').toBeGreaterThan(0)
    expect(direct.filter(([, range]) => range !== manifest.overrides.vitest)).toEqual([])
  })

  it('one vitest is installed, and every @vitest package is at the pinned version', () => {
    const copies = installed(/(^|\/)node_modules\/(vitest|@vitest\/[^/]+)$/)
    expect(copies.length, 'the scan found no vitest at all, so it proves nothing').toBeGreaterThan(1)
    const off = copies
      .filter(([, found]) => found.version !== manifest.overrides.vitest)
      .map(([path, found]) => `${path}@${found.version}`)
    expect(off).toEqual([])
    expect(copies.filter(([path]) => path.endsWith('node_modules/vitest'))).toHaveLength(1)
  })
})

// Cloudflare Pages builds on whatever .node-version names, and on node 22.16.0 without one, which is
// below vite-plus's own floor. npm only warns for a regular dependency, but drops an OPTIONAL native
// binding that fails its engine check without a word, so a floor raised past the pin breaks the deploy
// and nothing local. The ranges these packages publish are ^x.y.z and >=x.y.z joined by ||; anything
// else throws rather than being guessed at.
const parse = (version: string) => version.split('.').map(Number)
const atLeast = ([a = 0, b = 0, c = 0]: number[], [x = 0, y = 0, z = 0]: number[]) => a !== x ? a > x : b !== y ? b > y : c >= z
const satisfies = (version: string, range: string) => range.split('||').some(clause => {
  const match = /^(\^|>=)(\d+\.\d+\.\d+)$/.exec(clause.trim())
  if (!match?.[2]) throw new Error(`unsupported engines clause: ${clause}`)
  const [have, floor] = [parse(version), parse(match[2])]
  return atLeast(have, floor) && (match[1] === '>=' || have[0] === floor[0])
})

describe('Pages builds on a node the toolchain accepts', () => {
  it('the range check can tell an accepted node from a refused one (control)', () => {
    expect(satisfies('24.21.0', '^20.19.0 || ^22.18.0 || >=24.11.0')).toBe(true)
    expect(satisfies('22.16.0', '^20.19.0 || ^22.18.0 || >=24.11.0')).toBe(false)
    expect(satisfies('21.0.0', '^20.19.0 || >=24.11.0')).toBe(false)
  })

  it('.node-version satisfies vite-plus, vite-plus-core, vitest and the linux native binding', () => {
    const pinned = NODE_VERSION.trim()
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    const refused = [
      'node_modules/vite-plus',
      'node_modules/vite',
      'node_modules/vitest',
      // what Pages installs on its linux x64 image, and the one npm would drop in silence
      'node_modules/@voidzero-dev/vite-plus-linux-x64-gnu',
    ]
      .map(path => [path, entry(path).engines?.node] as const)
      .filter(([, range]) => !range || !satisfies(pinned, range))
    expect(refused).toEqual([])
  })
})
