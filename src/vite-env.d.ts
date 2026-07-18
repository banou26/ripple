/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __COMMIT_HASH__: string

// PWA Launch Handler API (Chromium). Not yet part of the standard DOM lib, so it
// is declared here to type window.launchQueue for the .torrent / magnet handlers.
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
