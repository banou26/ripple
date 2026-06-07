// https://github.com/sodatea/vite-plugin-node-stdlib-browser
import { createRequire } from 'module'

import inject from '@rollup/plugin-inject'
import stdLibBrowser from 'node-stdlib-browser'
import esbuildPlugin from 'node-stdlib-browser/helpers/esbuild/plugin'
import {
  handleCircularDependancyWarning
} from 'node-stdlib-browser/helpers/rollup/plugin'


const require = createRequire(import.meta.url)

// Vite's optimizeDeps scanner marks every node_modules path it encounters as
// external. esbuild then rejects "injected path cannot be marked as external"
// for the shim. This plugin runs first and short-circuits the shim's resolution
// with `external: false`, so the scanner never gets a chance to externalize it.
const shimPath = require.resolve('node-stdlib-browser/helpers/esbuild/shim')
const keepShimInternalPlugin = {
  name: 'keep-stdlib-browser-shim-internal',
  setup(build) {
    build.onResolve(
      { filter: /node-stdlib-browser[\\/]helpers[\\/]esbuild[\\/]shim/ },
      () => ({ path: shimPath, external: false })
    )
  }
}

const plugin = () => ({
  name: 'vite-plugin-node-stdlib-browser',
  config: () => ({
    resolve: {
      // Drop net/dgram so they fall through to vite.config's alias →
      // @webvpn/net/@webvpn/dgram (real peers), not the null stub WebTorrent
      // would otherwise import.
      alias: (() => { const { net, dgram, ...rest } = stdLibBrowser; return rest })()
    },
    optimizeDeps: {
      include: ['buffer', 'process'],
      esbuildOptions: {
        inject: [shimPath],
        define: {
          global: 'global',
          process: 'process',
          Buffer: 'Buffer'
        },
        // Pre-bundled deps (e.g. webtorrent's webtorrent.min.js) carry
        // //# sourceMappingURL=… comments. esbuild's scanner follows them
        // and errors out with "No loader is configured for .map files"
        // unless we tell it to treat them as empty.
        loader: { '.map': 'empty' },
        plugins: [keepShimInternalPlugin, esbuildPlugin(stdLibBrowser)]
      }
    },
    plugins: [
      {
        ...inject({
          global: [
            require.resolve('node-stdlib-browser/helpers/esbuild/shim'),
            'global'
          ],
          process: [
            require.resolve('node-stdlib-browser/helpers/esbuild/shim'),
            'process'
          ],
          Buffer: [
            require.resolve('node-stdlib-browser/helpers/esbuild/shim'),
            'Buffer'
          ]
        }),
        enforce: 'post'
      }
    ],
    build: {
      rollupOptions: {
        onwarn: (warning, rollupWarn) => {
          handleCircularDependancyWarning(warning, rollupWarn)
        }
      }
    }
  })
})

export default plugin
