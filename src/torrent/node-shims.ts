// Imported first so the process shim exists before @fkn/lib/{net,dgram}'s readable-stream dereferences it; nextTick must forward trailing args

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
