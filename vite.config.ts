import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
// CF Pages exposes the build's commit; fall back to local git, then the main branch
// ('main' resolves on GitHub's /commit/ path to the latest commit there).
const commitHash =
  process.env.CF_PAGES_COMMIT_SHA ||
  (() => { try { return execSync('git rev-parse HEAD').toString().trim() } catch { return 'main' } })()

export default defineConfig((env) => ({
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: ['src/index.tsx'],
      formats: ['es']
    }
  },
  server: {
    fs: {
      // Serve the sibling local file: deps in dev - libtorrent-wasm/build (the
      // .wasm the emscripten glue fetches) and fkn/web/lib. Without this vite's
      // /@fs/ returns the SPA fallback HTML for the .wasm → "expected magic word".
      allow: ['..']
    }
  },
  resolve: {
    // The symlinked libtorrent-wasm carries its own @fkn/lib + osra; without dedupe the worker's dgram talks to a different @fkn/lib than relayWorker bridges
    dedupe: ['@fkn/lib', 'osra'],
  },
  optimizeDeps: {
    include: ['@fkn/lib'],
  },
  worker: {
    format: 'es',
    // No React plugin here: Fast Refresh's import.meta.hot injection into the worker's @fkn/lib graph corrupts the osra relay
    plugins: () => [polyfills()],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(env.mode),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  plugins: [
    react({
      jsxImportSource: '@emotion/react'
    }),
    polyfills(),
  ]
}))
