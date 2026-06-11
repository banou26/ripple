// Imported FIRST (before @webvpn/{net,dgram}) so the global/process shims exist
// before readable-stream - pulled in transitively by @webvpn - dereferences
// `process` at module-eval time. process.nextTick MUST forward trailing args
// (readable-stream calls process.nextTick(resume_, stream, state)).

const root: any = typeof globalThis !== 'undefined' ? globalThis
  : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}))

if (!root.global) root.global = root
if (!root.process) {
  root.process = {
    env: { NODE_DEBUG: '' },
    version: '',
    browser: true,
    platform: 'browser',
    nextTick: (fn: any, ...args: any[]) => queueMicrotask(() => fn(...args)),
    emit: () => false,
    on: () => root.process,
    once: () => root.process,
    off: () => root.process,
    removeListener: () => root.process,
    cwd: () => '/',
  }
}
