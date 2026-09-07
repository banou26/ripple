/**
 * Keeps jassub's own copies of its worker, wasm and font out of the app bundle.
 *
 * jassub resolves a default for each of them with `new URL('./...', import.meta.url)`, and a bundler
 * follows those statically whether or not the branch can ever run. Ripple always passes all four urls
 * (see `src/router/embed.tsx`), so every one of those defaults is dead code, and following them costs
 * a great deal: ripple builds with `build.lib` set, where vite inlines assets as base64 and ignores
 * `assetsInlineLimit`, so the emitted graph came to a 2,873,243 byte worker chunk and a 2,841,695 byte
 * emscripten glue chunk, both carrying the wasm inline, neither ever fetched. It also emitted a second
 * `assets/worker-<hash>.js`, which `scripts/build-sw.mjs` refuses because it can no longer tell which
 * one is ripple's engine worker.
 *
 * The assets ripple actually serves are built by `vite.jassub.config.ts` into `build/jassub`, with
 * `lib` unset so none of that inlining applies. This plugin belongs to the APP build only; the asset
 * pass needs the real graph.
 *
 * Each replacement is asserted. A jassub upgrade that renames any of these should fail the build
 * loudly rather than quietly go back to bundling five megabytes nobody loads.
 */
const refuse = (what) =>
  `(() => { throw new Error('jassub\\'s bundled ${what} is not built into this app; pass the url explicitly') })()`

const REPLACEMENTS = [
  [
    "new Worker(new URL('./worker/worker.js', import.meta.url), { name: 'jassub-worker', type: 'module' })",
    refuse('worker'),
  ],
  [
    "new URL('./wasm/jassub-worker-modern.wasm', import.meta.url).href",
    refuse('simd wasm'),
  ],
  [
    "new URL('./wasm/jassub-worker.wasm', import.meta.url).href",
    refuse('fallback wasm'),
  ],
  [
    "new URL('./default.woff2', import.meta.url).href",
    refuse('fallback font'),
  ],
]

export default () => ({
  name: 'jassub-own-assets',
  enforce: 'pre',
  transform (code, id) {
    if (!id.includes('jassub/dist/jassub.js')) return null
    let out = code
    for (const [from, to] of REPLACEMENTS) {
      if (!out.includes(from)) {
        this.error(`jassub-own-assets: jassub no longer contains ${JSON.stringify(from)}; re-check what the app build is pulling in`)
      }
      out = out.replaceAll(from, to)
    }
    return { code: out, map: null }
  },
})
