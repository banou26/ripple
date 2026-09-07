/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __COMMIT_HASH__: string

interface LaunchParams {
  readonly targetURL?: string
  readonly files: readonly FileSystemFileHandle[]
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}
interface Window {
  launchQueue?: LaunchQueue
}

/**
 * `?no-inline&url`, which vite understands and vite's own ambient `*?url` declaration does not match.
 *
 * The wildcard in `declare module '*?url'` only matches a specifier ENDING in `?url`, so a second
 * query parameter takes the import out of its reach. jassub's wasm and fallback font need `no-inline`
 * to stay files rather than base64; see `src/jassub-assets.ts`.
 */
declare module '*?no-inline&url' {
  const url: string
  export default url
}
