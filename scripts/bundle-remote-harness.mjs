// The embedder's half of the remote-player spec, bundled so a page in the rig can load it.
//
// `remotePlayer` runs in the BROWSER, in the page that frames the embed, and the spec drives that
// page from node. The served build carries no node_modules, so the module is bundled into a single
// file the spec injects with `addScriptTag`. Written next to the test output, never into build/.
import { build } from 'vite'

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: 'test-results/remote-harness',
    emptyOutDir: true,
    lib: { entry: 'tests/remote-harness.ts', formats: ['es'], fileName: () => 'remote-harness.js' },
    minify: false,
  },
})
console.log('remote harness bundled into test-results/remote-harness/remote-harness.js')
