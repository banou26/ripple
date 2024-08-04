import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import polyfills from './vite-plugin-node-stdlib-browser.cjs'

export default defineConfig((env) => ({
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: ['src/index.tsx', 'src/worker/index.ts'],
      formats: ['es']
    },
    rollupOptions: {
      input: {
        index: 'src/index.tsx',
        'worker': 'src/worker/index.ts'
      }
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
