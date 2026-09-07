import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { defineConfig } from 'vite-plus'

/**
 * What the app addresses by fixed path, and roughly how big each should be.
 *
 * A jassub upgrade that renames or splits any of these would still build cleanly and would still
 * write SOMETHING here, and the app would then ask for a file that is not there. The floor sizes
 * catch the other half of it, an emitted stub where a real artefact belongs.
 */
const EXPECTED: [string, number][] = [
  ['worker.js', 20_000],
  ['jassub-worker.js', 10_000],
  ['jassub-worker-modern.wasm', 1_000_000],
  ['jassub-worker.wasm', 1_000_000],
  ['default.woff2', 50_000],
]

/**
 * A second build pass, for jassub's assets only.
 *
 * See `src/jassub-assets.ts` for why they cannot go through the app's own build. The two things that
 * matter here are that `lib` is UNSET, which is what stops vite inlining the wasm as base64, and that
 * the output names are stable, so the app can address them by a fixed path instead of a hash it would
 * have to be told about. `emptyOutDir` is false because this runs after the app build and writes into
 * the same directory.
 */
export default defineConfig({
  plugins: [{
    name: 'jassub-assets-are-really-there',
    closeBundle () {
      const dir = 'build/jassub'
      for (const [name, floor] of EXPECTED) {
        const path = join(dir, name)
        if (!existsSync(path)) throw new Error(`jassub asset pass emitted no ${path}; the app addresses it by that exact name`)
        const { size } = statSync(path)
        if (size < floor) throw new Error(`${path} is ${size} bytes, under the ${floor} floor; that is a stub rather than the real artefact`)
      }
    },
  }],
  // Relative, so the worker finds its own siblings wherever this directory is mounted. The default
  // `/` bakes the deploy root into the emitted references, and the root vite computes here is
  // `build/jassub` while ripple serves `build`, so the nested pthread worker would be looked for at
  // `/jassub-worker.js` and 404. Dev makes that worse again by serving the whole thing under
  // `/build/`. A relative base is right for all three.
  base: './',
  // The worker gets its own output names too: vite names worker chunks from `worker.rollupOptions`
  // and not from `build.rollupOptions`, so leaving this out emits `assets/worker-<hash>.js` however
  // the main output is configured.
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  build: {
    outDir: 'build/jassub',
    target: 'esnext',
    emptyOutDir: true,
    rollupOptions: {
      input: { 'jassub-assets': 'src/jassub-assets.ts' },
      preserveEntrySignatures: 'allow-extension',
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
