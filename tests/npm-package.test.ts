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
import { entryIn, npmManifest as manifestFor, TYPES } from '../scripts/write-npm-manifest.mjs'

import { describe, expect, it } from 'vitest'

const npmManifest = (pkg: Record<string, unknown>) => manifestFor(pkg, 'index-Bx33zPvJ.js')

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
  'index-Bx33zPvJ.js',
  'assets/worker-SJZDGuG-.js',
  'libav-worker.js',
  'libav.wasm',
  'libav-jspi.wasm',
  'sw.js',
  'jassub/worker.js',
  'jassub/jassub-worker.wasm',
  'jassub/jassub-worker.js',
  'jassub/jassub-worker-modern.wasm',
  'jassub/jassub-worker-modern.js',
  'jassub/default.woff2',
  'jassub/noto-sans-jp.otf',
  TYPES,
]

/** ripple-plugin@1's types as tsc writes them: comments and type aliases, nothing else */
const DECLARATION = `/** Where ripple draws a button. */
export type ButtonPlace = 'header' | 'row-menu' | 'settings';
export type RipplePlugin = {
    asks: string[];
};
`

const ENTRY = 'import"./api.js";const w=new Worker(new URL("/assets/worker-SJZDGuG-.js",import.meta.url));fetch("/libav-worker.js");navigator.serviceWorker.register("/sw.js")'

/** a tree over a list of paths, with the entry's own bytes and the plugin types' */
const tree = (paths: string[], entry = ENTRY, declaration = DECLARATION) => ({
  read: (path: string) => (!paths.includes(path) ? undefined : path === TYPES ? declaration : entry),
  exists: (path: string) => paths.includes(path),
})

describe('the manifest that ships with the built site', () => {
  it('points main at the root of the directory it sits in', () => {
    expect(npmManifest(REPO).main).toBe('index-Bx33zPvJ.js')
  })

  // the entry's name changes with its bytes on every release, so it is read off the page the build wrote
  it('names the entry the built index.html loads', () => {
    const html = '<head><link rel="modulepreload" crossorigin href="/assets/osra-AAAA1111.js"><script type="module" crossorigin src="/index-Bx33zPvJ.js"></script></head>'
    expect(entryIn(html)).toBe('index-Bx33zPvJ.js')
  })

  it('refuses a page that loads no hashed entry at the root', () => {
    for (const html of [
      '<script type="module" src="/index.js"></script>',
      '<script type="module" src="/assets/index-Bx33zPvJ.js"></script>',
      '<script type="module" src="/src/index.tsx"></script>',
    ]) expect(() => entryIn(html), html).toThrow('index.html loads no /index-<hash>.js')
  })

  it('carries what provenance and the platform read, and nothing that would install', () => {
    const built = npmManifest(REPO)
    expect(built.repository).toEqual(REPO.repository)
    expect(built.keywords).toEqual(['fkn', 'fkn-type:app'])
    expect(built.dependencies, 'the app is bundled and unpkg installs nothing').toBeUndefined()
    expect(built.scripts, 'there is nothing to run in a built site').toBeUndefined()
  })

  // the ownership claim is read off the PUBLISHED manifest, and this file is what publishes it. A
  // filter that drops it leaves the source pending for ever with every gate green
  it('carries the fkn ownership claim through to the published manifest', () => {
    const claim = { app: `fkn:app:1${'a'.repeat(52)}` }
    expect(npmManifest({ ...REPO, fkn: claim }).fkn).toEqual(claim)
  })

  // THE CONTROL: a field the list does NOT name is still dropped, so the row above is the list
  // carrying `fkn` rather than the filter having stopped filtering
  it('still drops a field the list does not name', () => {
    expect(npmManifest({ ...REPO, devDependencies: { vite: '^7.0.0' } }).devDependencies).toBeUndefined()
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

  // the engine worker fetches the WebRTC stack's wasm by an absolute path, which only the worker's own bytes name
  it('refuses a path a script the entry names asks for, when the package does not carry it', () => {
    const WORKER = 'const wasm=`/assets/webrtc-DCtPDVeu.wasm`;fetch(wasm)'
    const files = (paths: string[]) => ({
      read: (path: string) => !paths.includes(path) ? undefined : path === 'assets/worker-SJZDGuG-.js' ? WORKER : path === TYPES ? DECLARATION : ENTRY,
      exists: (path: string) => paths.includes(path),
    })
    expect(packageProblems(npmManifest(REPO), REPO, files([...SITE, 'assets/webrtc-DCtPDVeu.wasm']))).toEqual([])
    expect(packageProblems(npmManifest(REPO), REPO, files(SITE)).join('\n'))
      .toContain('/assets/worker-SJZDGuG-.js, which index-Bx33zPvJ.js names, names /assets/webrtc-DCtPDVeu.wasm')
  })

  it('refuses a file the entry only reaches by building a url at runtime', () => {
    // no scan of the entry can see `new URL('worker.js', jassubBase)`, so these are named outright
    const missing = SITE.filter((p) => p !== 'jassub/jassub-worker.wasm')
    expect(packageProblems(npmManifest(REPO), REPO, tree(missing)).join('\n')).toContain('jassub/jassub-worker.wasm')
  })

  it('refuses a store listing that names an image the package does not carry', () => {
    const LISTING = { background: 'store/background.webp', cover: 'store/cover.webp', screenshots: ['store/library.webp'] }
    const listed = npmManifest({ ...REPO, fkn: LISTING })
    expect(packageProblems(listed, REPO, tree([...SITE, 'store/background.webp', 'store/cover.webp', 'store/library.webp']))).toEqual([])
    expect(packageProblems(listed, REPO, tree([...SITE, 'store/background.webp', 'store/cover.webp'])).join('\n'))
      .toContain('the store listing names store/library.webp, which the package does not carry')
  })

  it('refuses a manifest left over from an older version', () => {
    const stale = { ...npmManifest(REPO), version: '0.0.7' }
    expect(packageProblems(stale, REPO, tree(SITE)).join('\n')).toContain('the published version is "0.0.7"')
  })

  it('refuses an entry that is not a module', () => {
    const problems = packageProblems(npmManifest(REPO), REPO, tree(SITE, 'console.log("hi")'))
    expect(problems.join('\n')).toContain('carries no import or export')
  })
})

describe('the plugin types the package exports', () => {
  it('are named in the manifest, and carried', () => {
    expect(npmManifest(REPO).types).toBe('types/contract.d.ts')
    expect(packageProblems(npmManifest(REPO), REPO, tree(SITE.filter((p) => p !== TYPES))).join('\n'))
      .toContain('"types" names types/contract.d.ts, which the package does not carry')
    const { types: _none, ...untyped } = npmManifest(REPO)
    expect(packageProblems(untyped, REPO, tree(SITE)).join('\n')).toContain('declares no "types"')
  })

  // the package's main is the whole app, so a value a declaration names would type-check and then load ripple
  it('declare no value and import nothing, so they stand alone', () => {
    for (const value of ['export declare const PLUGIN_PROTOCOL = "ripple-plugin@1";', 'export declare function connect(): void;', 'declare class Host {}']) {
      expect(packageProblems(npmManifest(REPO), REPO, tree(SITE, ENTRY, DECLARATION + value)).join('\n'), value).toContain('declares a value')
    }
    for (const imported of ['import type { Torrent } from "../torrent/types";', 'export type { Torrent } from "../torrent/types";']) {
      expect(packageProblems(npmManifest(REPO), REPO, tree(SITE, ENTRY, imported + DECLARATION)).join('\n'), imported).toContain('imports a module')
    }
  })
})
