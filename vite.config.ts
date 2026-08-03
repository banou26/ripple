import { defineConfig, lazyPlugins } from 'vite-plus'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import polyfills from './vite-plugin-node-stdlib-browser.mjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const commitHash =
  process.env.CF_PAGES_COMMIT_SHA ||
  (() => {
    try {
      return execSync('git rev-parse HEAD').toString().trim()
    } catch {
      // 'main' resolves on GitHub's /commit/ path to the latest commit there, which is what the footer link in home.tsx builds
      return 'main'
    }
  })()

export default defineConfig((env) => ({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts', 'examples/**'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        },
      },
    ],
  },
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: ['src/index.tsx'],
      formats: ['es'],
    },
  },
  server: {
    fs: {
      // Without this vite's /@fs/ returns the SPA fallback HTML for the sibling .wasm → "expected magic word"
      allow: ['..'],
    },
  },
  resolve: {
    // The symlinked libtorrent-wasm carries its own @fkn/lib + osra; without dedupe the worker's dgram talks to a different @fkn/lib than relayWorker bridges
    dedupe: ['@fkn/lib', 'osra'],
  },
  optimizeDeps: {
    include: ['@fkn/lib', '@fkn/lib/react'],
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
  plugins: lazyPlugins(() => [
    react({
      jsxImportSource: '@emotion/react',
    }),
    polyfills(),
  ]),
}))
