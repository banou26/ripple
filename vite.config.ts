import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import topLevelAwait from 'vite-plugin-top-level-await'

import polyfills from './vite-plugin-node-stdlib-browser.cjs'

// https://vitejs.dev/config/
export default defineConfig((env) => ({
  build: {
    target: 'esnext',
    outDir: 'dist',
    lib: {
      entry: ['src/index.tsx', 'src/shared-worker/index.ts', 'src/worker/index.ts'],
      formats: ['es']
    },
    rollupOptions: {
      input: {
        index: 'src/index.tsx',
        'shared-worker': 'src/shared-worker/index.ts',
        'worker': 'src/worker/index.ts'
      },
      plugins: [
        react({
          jsxImportSource: '@emotion/react'
        }),
        polyfills(),
        topLevelAwait()
      ]
    }
  },
  define: env.mode === 'development' ? {} : {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  plugins: [
    react({
      jsxImportSource: '@emotion/react'
    }),
    polyfills()
  ]
}))


// import { defineConfig } from 'vite'
// import react from '@vitejs/plugin-react'
// import rollupNodePolyFill from 'rollup-plugin-polyfill-node'
// import topLevelAwait from 'vite-plugin-top-level-await'

// import polyfills from './vite-plugin-node-stdlib-browser.cjs'

// export default defineConfig((env) => ({
//   build: {
//     target: 'esnext',
//     outDir: 'dist',
//     rollupOptions: {
//       plugins: [
//         rollupNodePolyFill()
//       ]
//     },
//     lib: {
//       name: 'Stub',
//       fileName: 'index',
//       entry: ['src/index.tsx', 'src/shared-worker/index.ts', 'src/worker/index.ts'],
//       formats: ['es']
//     }
//   },
//   define: env.mode === 'development' ? {} : {
//     'process.env.NODE_ENV': JSON.stringify('production')
//   },
//   plugins: [
//     react({
//       jsxImportSource: '@emotion/react'
//     }),
//     polyfills(),
//     topLevelAwait()
//   ],
//   server: {
//     hmr: {
//       protocol: 'ws',
//       host: 'localhost',
//       port: 4560,
//       clientPort: 4560
//     },
//     fs: {
//       allow: ['../..']
//     }
//   }
// }))
