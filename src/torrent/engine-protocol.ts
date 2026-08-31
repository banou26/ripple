// The engine has to live in a dedicated worker: libtorrent's OPFS backend needs createSyncAccessHandle, which is absent in a SharedWorker.
//
// Deliberately thin: a follower forwards the exact message the direct client would post to its own worker and the leader hands it straight on, so there is no
// per-command translation table to fall out of sync. Not hypothetical: `recheck` was added to the client and the worker but not to the worker's allowlist, and
// the button shipped doing nothing.

export const CONTROL_CHANNEL = 'ripple:torrent'

// One per follower: a BroadcastChannel deserialises its payload once per listening context, and read results run to several megabytes.
export const replyChannel = (clientId: string) => `ripple:torrent:${clientId}`

export const ENGINE_LOCK = 'ripple:torrent-engine'

// Identifies one engine session: after a handover the same handle names a different torrent, so a stale `remove` would delete the wrong files.
export type Generation = string

export type Envelope =
  | { to: 'leader', from: string, gen: Generation | null, msg: any }
  | { to: 'all', gen: Generation, msg: any }

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

export const newClientId = randomId
export const newGeneration = randomId

export const hasWebLocks = (): boolean => typeof navigator !== 'undefined' && !!navigator.locks

export type TransportHost = {
  message: (msg: any) => void
  error: (message: string, fatal: boolean) => void
}

export type Transport = {
  post: (msg: any, transfer: Transferable[]) => void
  destroy: () => void
  /**
   * Commands this transport accepted but never delivered, handed over and forgotten.
   *
   * A follower holds every command until a leader speaks, and the transport is then REPLACED the moment
   * this document wins the election. Without a way to carry that backlog across the swap it is dropped
   * in silence, which is worse than any error: `/embed` issues its `add-magnet` inside exactly that
   * window, so the torrent is never added and the player waits on metadata for a torrent the engine has
   * never heard of. Only a queueing transport implements this.
   */
  pending?: () => any[]
}

export type TransportFactory = (host: TransportHost, docId: string) => Transport

// Read replies are excluded on purpose: those belong to whoever asked, and go to that tab's own channel.
export const BROADCAST_TYPES = new Set([
  'ready', 'state', 'list', 'storage-unavailable', 'storage-full', 'add-failed', 'worker-error', 'error', 'fatal',
])

export const ENGINE_RESET = 'engine-reset'

// Ten ticks of the leader's worker posting state on a fixed 500ms tick, which doubles as its heartbeat.
// Headroom for a busy main thread, not for throttling: real Chromium and Firefox hold the 500ms interval closely even when backgrounded. Playwright's headless
// Firefox does throttle it hard, which is worth knowing when a test that watches the engine looks flaky. Deciding a leader is gone is cheap, since any later
// broadcast marks it up again; the expensive mistake is posting a command into a gap where nobody is listening.
export const LEADER_SILENCE_MS = 5_000

/**
 * The commands whose `handle` only means anything inside the ONE session that issued it.
 *
 * A handle is not an identifier for a torrent, it is a counter inside a libtorrent session:
 * `id_for_hash` hands out `next_handle_id++` the first time it sees an info hash, so what a number
 * maps to is decided by the order that session happened to meet its torrents in. Two engines
 * restoring the same library agree only while the list and the order are identical, and neither is
 * stable across a handover: the restore loop skips entries with `started === false`, and torrents
 * added or removed during one engine's life are met in a completely different order by the next.
 * Flip one torrent off and every id after it shifts by one.
 *
 * So a command held across an engine replacement and delivered to its successor is not merely stale,
 * it can address a DIFFERENT TORRENT than the one the person clicked on, and `remove` carries
 * `deleteFiles`. The follower transport already refuses these by stamping a generation on what it
 * sends and having the leader drop anything that does not match, but a command parked in the client's
 * own gate is re-stamped with the new generation on the way out and walks straight past that guard.
 * These are therefore dropped rather than carried.
 *
 * The rest are safe to carry and MUST be: they name a torrent by info hash or carry no target at all,
 * and dropping them reintroduces the bug `gate.ts` exists to describe, where `/embed` loses the
 * `add-magnet` it issues during its own election and waits forever on metadata.
 */
export const SESSION_SCOPED = new Set([
  'inspect', 'pause', 'queue-move', 'read', 'reannounce', 'recheck', 'remove', 'resume',
  'retry', 'set-flags', 'set-folder', 'set-limits', 'set-plan', 'watch',
])

export const isSessionScoped = (type: unknown): boolean =>
  typeof type === 'string' && SESSION_SCOPED.has(type)
