/**
 * What @banou/ripple 0.0.7 shipped, and why nothing here saw it.
 *
 * The platform maps a tenant path 1:1 onto a package path, so an app that asks for
 * `/libav-worker.js` is asking the package root. Ripple asks with absolute paths because on
 * torrent.fkn.app the origin root IS build/, and every suite drives that site, where the paths are
 * correct by construction. Published from the repo root with `main: build/index.js`, all three of
 * them landed a directory too deep: https://fkn.app/app/npm:@banou/ripple reported "The download
 * engine stopped" over a 404 for `/assets/worker-SJZDGuG-.js`.
 *
 * So the package is now the BUILT SITE, and this pins the two halves of that: the manifest written
 * beside it, and the check that refuses a layout the platform could not load.
 */
import { packageProblems } from '../scripts/check-npm-package.mjs'
import { npmManifest } from '../scripts/write-npm-manifest.mjs'

import { describe, expect, it } from 'vitest'

const REPO = {
  name: '@banou/ripple',
  version: '0.0.8',
  type: 'module',
  repository: { type: 'git', url: 'git+https://github.com/banou26/ripple.git' },
  keywords: ['fkn', 'fkn-type:app'],
  scripts: { build: 'vp build' },
  dependencies: { react: '^19.0.0' },
}

/** everything the entry reaches, at the paths a tenant would ask for */
const SITE = [
  'index.js',
  'assets/worker-SJZDGuG-.js',
  'libav-worker.js',
  'libav.wasm',
  'libav-jspi.wasm',
  'sw.js',
  'jassub/worker.js',
  'jassub/jassub-worker.wasm',
  'jassub/jassub-worker-modern.wasm',
  'jassub/default.woff2',
  'fkn.json',
  '.well-known/fkn.json',
]

const ENTRY = 'import"./api.js";const w=new Worker(new URL("/assets/worker-SJZDGuG-.js",import.meta.url));fetch("/libav-worker.js");navigator.serviceWorker.register("/sw.js")'

/** a tree over a list of paths, with the entry's own bytes */
const tree = (paths: string[], entry = ENTRY) => ({
  read: (path: string) => (paths.includes(path) ? entry : undefined),
  exists: (path: string) => paths.includes(path),
})

describe('the manifest that ships with the built site', () => {
  it('points main at the root of the directory it sits in', () => {
    expect(npmManifest(REPO).main).toBe('index.js')
  })

  it('carries what provenance and the platform read, and nothing that would install', () => {
    const built = npmManifest(REPO)
    expect(built.repository).toEqual(REPO.repository)
    expect(built.keywords).toEqual(['fkn', 'fkn-type:app'])
    expect(built.dependencies, 'the app is bundled and unpkg installs nothing').toBeUndefined()
    expect(built.scripts, 'there is nothing to run in a built site').toBeUndefined()
  })
})

describe('the layout 0.0.7 published', () => {
  it('is refused, entry and every absolute path it names', () => {
    const problems = packageProblems(
      { ...REPO, main: 'build/index.js' },
      REPO,
      tree(['build/index.js', ...SITE.map((p) => `build/${p}`)]),
    )
    expect(problems.join('\n')).toContain('"main" is "build/index.js"')
    expect(problems.join('\n'), 'the exact 404 the engine died on').toContain('/assets/worker-SJZDGuG-.js')
    expect(problems.join('\n')).toContain('/libav-worker.js')
  })
})

describe('the built site as the package root', () => {
  it('passes', () => {
    expect(packageProblems(npmManifest(REPO), REPO, tree(SITE))).toEqual([])
  })

  it('refuses an absolute path the package does not carry', () => {
    const missing = SITE.filter((p) => p !== 'assets/worker-SJZDGuG-.js')
    expect(packageProblems(npmManifest(REPO), REPO, tree(missing)).join('\n')).toContain('/assets/worker-SJZDGuG-.js')
  })

  it('refuses a file the entry only reaches by building a url at runtime', () => {
    // no scan of the entry can see `new URL('worker.js', jassubBase)`, so these are named outright
    const missing = SITE.filter((p) => p !== 'jassub/jassub-worker.wasm')
    expect(packageProblems(npmManifest(REPO), REPO, tree(missing)).join('\n')).toContain('jassub/jassub-worker.wasm')
  })

  it('refuses a manifest left over from an older version', () => {
    const stale = { ...npmManifest(REPO), version: '0.0.7' }
    expect(packageProblems(stale, REPO, tree(SITE)).join('\n')).toContain('the published version is "0.0.7"')
  })

  it('refuses a package with no signed manifest, which the platform swallows in silence', () => {
    const missing = SITE.filter((p) => p !== 'fkn.json')
    expect(packageProblems(npmManifest(REPO), REPO, tree(missing)).join('\n')).toContain('fkn.json is missing')
  })

  it('refuses one with no /.well-known copy, which is what a host is asked for', () => {
    const missing = SITE.filter((p) => p !== '.well-known/fkn.json')
    expect(packageProblems(npmManifest(REPO), REPO, tree(missing)).join('\n')).toContain('.well-known/fkn.json is missing')
  })

  it('refuses an entry that is not a module', () => {
    const problems = packageProblems(npmManifest(REPO), REPO, tree(SITE, 'console.log("hi")'))
    expect(problems.join('\n')).toContain('carries no import or export')
  })
})
