/**
 * jassub's worker and data files, built by their own pass.
 *
 * They are NOT part of the app bundle. jassub 2's worker is an ES module that imports `abslink` and
 * `lfa-ponyfill` by bare specifier, so it has to be built rather than copied, and the app build would
 * hash every name and call the worker `assets/worker-<hash>.js`, the name `scripts/build-sw.mjs` keeps
 * for the engine's own worker.
 *
 * So `vite.jassub.config.ts` builds this file on its own, with stable output names, into
 * `build/jassub`. Nothing imports this module at runtime: the app addresses the results by the fixed
 * paths in `src/router/embed.tsx`, the same way it already addresses libav's.
 */
// Exported, never a bare import: since vite 8.3.0 (#22473) a build drops a worker whose url no output
// chunk references, and a bare import tree-shakes to nothing, so worker.js and fonts.js silently
// stopped being written (measured with vite-plus 0.3.3, 2026-09-25).
export { default as worker } from 'jassub/dist/worker/worker.js?worker&url'
import 'jassub/dist/wasm/jassub-worker-modern.wasm?no-inline&url'
import 'jassub/dist/wasm/jassub-worker-modern.js?no-inline&url'
import 'jassub/dist/wasm/jassub-worker.wasm?no-inline&url'
import 'jassub/dist/wasm/jassub-worker.js?no-inline&url'
import 'jassub/dist/default.woff2?no-inline&url'
import '@banou/media-player/noto-sans-jp.otf?no-inline&url'
