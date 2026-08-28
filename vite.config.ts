import { readFile } from 'fs/promises'
import { defineConfig, lazyPlugins } from 'vite-plus'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import polyfills from './vite-plugin-node-stdlib-browser.mjs'

/** system Chrome, because playwright's own browser download does not work on NixOS */
const findChrome = () => {
  if (process.env.RIPPLE_CHROME) return process.env.RIPPLE_CHROME
  for (const binary of ['google-chrome-stable', 'google-chrome', 'chromium']) {
    try {
      const path = execFileSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).trim()
      if (path) return path
    } catch {}
  }
  return undefined
}

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

/**
 * Serve `/sw.js` from `src/` while developing.
 *
 * The service worker is copied into `build/` by the `copy-html` script, which only runs for a real
 * build, so under `vp dev` the request falls through to the SPA fallback and comes back as
 * index.html. The browser then logs "The script has an unsupported MIME type ('text/html')" on every
 * dev session, and the streamed download, which is entirely a service worker, cannot work at all.
 *
 * Read from disk per request rather than cached, so editing the worker and reloading is enough.
 */
const serveServiceWorkerInDev = () => ({
  name: 'ripple-serve-sw-in-dev',
  apply: 'serve' as const,
  configureServer (server: { middlewares: { use: (fn: (req: { url?: string }, res: ServerResponseLike, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? '').split('?')[0] !== '/sw.js') return next()
      readFile(new URL('./src/sw.js', import.meta.url), 'utf8')
        .then(body => {
          res.setHeader('content-type', 'text/javascript')
          // the worker must never be the stale thing deciding what the page gets
          res.setHeader('cache-control', 'no-store')
          res.end(body)
        })
        .catch(() => next())
    })
  },
})

type ServerResponseLike = { setHeader: (name: string, value: string) => void, end: (body: string) => void }

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
    //
    // React and emotion are listed for the same reason via @banou/media-player, which is symlinked in
    // development and would otherwise bring its own. The videojs entries only keep one copy in the
    // bundle: ripple imports no @videojs package itself, so a second copy would be weight rather than
    // a split store.
    dedupe: [
      '@fkn/lib', 'osra',
      'react', 'react-dom', '@emotion/react',
      '@videojs/core', '@videojs/react',
    ],
  },
  optimizeDeps: {
    // React and its consumers are listed so they share ONE pre-bundled copy. `dedupe` above resolves
    // them to a single file but does not decide how each is loaded, and a dependency left un-optimised
    // imports React's raw CJS build while the test renderer carries a pre-bundled one. Two instances,
    // one hooks dispatcher: any component reaching a tooltip dies on "Cannot read properties of null
    // (reading 'useState')", in the browser project only.
    include: [
      '@fkn/lib', '@fkn/lib/react',
      'react', 'react-dom', 'react-dom/client', 'react-tooltip', 'react-feather',
    ],
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
    serveServiceWorkerInDev(),
  ]),
  /**
   * `unit` is the pure logic in node. `browser` mounts things in real Chrome, which is the only place
   * a duplicated player store shows up: two copies of @videojs/core mean the chrome subscribes to one
   * and the player writes the other, and nothing throws, the controls just never respond.
   */
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.browser.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.{ts,tsx}'],
          browser: {
            enabled: true,
            headless: !process.env.RIPPLE_HEADFUL,
            provider: playwright({ launchOptions: { executablePath: findChrome() } }),
            // explicit: the default is a 414px phone, and the player chrome branches on 768px
            instances: [{ browser: 'chromium', viewport: { width: 1280, height: 720 } }],
          },
        },
      },
    ],
  },
}))
