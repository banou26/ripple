import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import preact from '@preact/preset-vite'

import polyfills from './vite-plugin-node-stdlib-browser.cjs'

export default defineConfig((env) => ({
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: ['src/index.tsx', 'src/shared-worker/index.ts', 'src/worker/index.ts'],
      formats: ['es']
    },
    rollupOptions: {
      input: {
        embed: 'embed.html',
        index: 'src/index.tsx',
        'shared-worker': 'src/shared-worker/index.ts',
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
    env.mode === 'development'
      ? (
        react({
          jsxImportSource: '@emotion/react'
        })
      )
      : (
        react({
          jsxImportSource: '@emotion/react'
        })
      ),
    polyfills()
  ]
}))
