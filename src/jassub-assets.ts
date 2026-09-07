/**
 * jassub's worker and data files, built by their own pass.
 *
 * They are NOT part of the app bundle, and cannot be. jassub 2's worker is an ES module that imports
 * `abslink` and `lfa-ponyfill` by bare specifier and spawns a nested pthread worker of its own, so it
 * has to be built rather than copied; and ripple builds with `build.lib` set, where vite inlines every
 * asset as base64 and ignores `assetsInlineLimit`, including the wasm jassub resolves for itself from
 * inside that worker. Measured on jassub 2.5.16: the worker chunk comes out at 2,922,207 bytes with
 * two base64 wasm blobs inside it under `lib`, against 110,525 bytes and none without it.
 *
 * So `vite.jassub.config.ts` builds this file on its own, with `lib` unset and stable output names,
 * into the same `build/` directory. Nothing imports this module at runtime: the app addresses the
 * results by the fixed paths in `jassub-urls.ts`, the same way it already addresses libav's.
 */
import 'jassub/dist/worker/worker.js?worker&url'
import 'jassub/dist/wasm/jassub-worker-modern.wasm?no-inline&url'
import 'jassub/dist/wasm/jassub-worker.wasm?no-inline&url'
import 'jassub/dist/default.woff2?no-inline&url'
