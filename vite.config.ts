import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

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
      // Serve the sibling local file: deps in dev — libtorrent-wasm/build (the
      // .wasm the emscripten glue fetches) and fkn/web/lib. Without this vite's
      // /@fs/ returns the SPA fallback HTML for the .wasm → "expected magic word".
      allow: ['..']
    }
  },
  worker: {
    format: 'es'
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
