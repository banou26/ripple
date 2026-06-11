import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

// WebTorrent's entry imports named symbols from its "browser exclude" deps;
// vite's __vite-browser-external stub has no named exports, so point them at a
// local no-op stub that does.
const wtExcluded = fileURLToPath(new URL('./src/torrent/webtorrent-excluded.ts', import.meta.url))

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
    alias: {
      'bittorrent-dht': wtExcluded,
      'load-ip-set': wtExcluded,
      '@silentbot1/nat-api': wtExcluded,
      'ut_pex': wtExcluded,
      // WebTorrent's `import net from 'net'` must hit @webvpn (real peers over
      // WebVPN), not node-stdlib-browser's null `net`/`dgram` stub.
      'net': '@webvpn/net',
      'dgram': '@webvpn/dgram',
    },
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
    'process.env.NODE_ENV': JSON.stringify(env.mode)
  },
  plugins: [
    react({
      jsxImportSource: '@emotion/react'
    }),
    polyfills(),
  ]
}))
