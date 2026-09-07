import { describe, expect, it } from 'vitest'

import CONFIG from '../vite.jassub.config.ts?raw'
import EMBED from '../src/router/embed.tsx?raw'

/**
 * The app and the build pass have to agree on jassub's filenames, and nothing else makes them.
 *
 * jassub 2's worker cannot be copied out of node_modules: it is an ES module importing `abslink` and
 * `lfa-ponyfill` by bare specifier that spawns a nested worker of its own, so `vite.jassub.config.ts`
 * builds it. That pass names its output itself, and `src/router/embed.tsx` addresses the results by
 * fixed path, so the two are joined by a string and by nothing a compiler can see.
 *
 * Getting it wrong is silent in the worst way. The playwright rig serves the build with `serve -s`,
 * which rewrites a missing path to index.html with a 200 and `text/html`, so a renamed asset comes
 * back as HTML rather than a 404 and jassub fails somewhere inside a worker with an error that names
 * no file. The build pass has its own floor-size guard for whether the files exist; this is the other
 * half, that they are the ones the app will ask for.
 *
 * Read through vite with `?raw` rather than `node:fs`, for the reason `lanes.test.ts` records: this
 * runs in the `unit` project, whose config applies `vite-plugin-node-stdlib-browser`, and importing
 * `node:fs` there dies resolving `punycode`.
 */

/** Every name the app builds a url for, and the base it builds them against. */
const ASSETS = ['worker.js', 'jassub-worker-modern.wasm', 'jassub-worker.wasm', 'default.woff2']

describe('jassub asset names', () => {
  it('are the same in the build pass and in the app', () => {
    for (const name of ASSETS) {
      expect(CONFIG, `${name} is not in the build pass's expected list`).toContain(`'${name}'`)
      expect(EMBED, `${name} is not addressed by the app`).toContain(`'${name}'`)
    }
  })

  it('are served from the directory the build pass writes to', () => {
    // outDir and the url base have to name the same directory, or every asset 404s together
    expect(CONFIG, 'the build pass no longer writes to build/jassub').toContain("outDir: 'build/jassub'")
    expect(EMBED, 'the app no longer reads from /jassub/').toContain("/jassub/`")
  })

  it('reads both files, so the assertions cannot pass by matching nothing', () => {
    expect(CONFIG.length).toBeGreaterThan(500)
    expect(EMBED.length).toBeGreaterThan(500)
    expect(CONFIG).toContain('jassub')
    expect(EMBED).toContain('jassubWorkerUrl')
  })
})
