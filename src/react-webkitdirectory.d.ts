/**
 * `webkitdirectory`, which React does not type.
 *
 * It is a real attribute in every browser and `HTMLInputElement.webkitdirectory` is in lib.dom, but
 * @types/react's `InputHTMLAttributes` lists `multiple` and `capture` and not this one. Declared so
 * the one input that needs it reads like any other rather than being cast at the call site.
 *
 * Its own file, and the `import 'react'` is load bearing: `declare module` inside a GLOBAL .d.ts
 * (one with no top-level import or export, which `vite-env.d.ts` is) declares a replacement module
 * rather than augmenting the real one, and React's every export then disappears.
 */
import 'react'

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
  }
}
