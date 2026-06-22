import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
// CF Pages exposes the build's commit; fall back to local git, then 'dev'.
const commitHash =
  process.env.CF_PAGES_COMMIT_SHA ||
  (() => { try { return execSync('git rev-parse HEAD').toString().trim() } catch { return 'dev' } })()

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
    // ripple imports the SYMLINKED libtorrent-wasm, which carries its own
    // node_modules/@fkn/lib + osra. Without dedupe vite loads two @fkn/lib /
    // osra instances; the worker's dgram then talks to a different @fkn/lib
    // than relayWorker bridges → every socket call hangs. Force one instance.
    dedupe: ['@fkn/lib', 'osra', '@webvpn/net', '@webvpn/dgram'],
  },
  optimizeDeps: {
    include: ['@webvpn/net', '@webvpn/dgram', '@fkn/lib'],
  },
  worker: {
    format: 'es',
    // Only the node-stdlib polyfills in the worker - NOT @vitejs/plugin-react.
    // React Fast Refresh injects `import.meta.hot` component-registration code
    // into every module it processes, including the worker's @webvpn/@fkn/lib
    // graph, which corrupts the osra relay connection (the worker's socket
    // calls then never reach the iframe). The app's worker uses no React plugin.
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
