// The wire between a tab that owns the engine and the tabs that borrow it.
//
// The engine has to live in a dedicated worker: libtorrent's OPFS backend needs
// createSyncAccessHandle, which is [Exposed=DedicatedWorker] and is simply absent in a
// SharedWorker. So one tab is elected to host the worker and the others talk to it from
// here.
//
// Deliberately thin. A follower forwards the exact message the direct client would have
// posted to its own worker, and the leader hands it straight on, so there is no per-command
// translation table to fall out of sync. That mistake is not hypothetical: `recheck` was
// added to the client and to the worker but not to the worker's allowlist, and the button
// shipped doing nothing.

// Everyone joins this one. Followers put commands on it, the leader puts broadcasts on it.
export const CONTROL_CHANNEL = 'ripple:torrent'

// One per follower, for replies meant for that follower alone. Read results run to several
// megabytes, and a BroadcastChannel deserialises its payload once per listening context, so
// putting them on the shared channel would make every open tab pay for bytes it will not
// look at.
export const replyChannel = (clientId: string) => `ripple:torrent:${clientId}`

// Held for the lifetime of the owning tab. The browser releases it when that tab closes OR
// crashes, which is the whole reason for using a lock rather than a heartbeat.
export const ENGINE_LOCK = 'ripple:torrent-engine'

// Identifies one engine session. A torrent handle is a counter inside a libtorrent session,
// so the same integer names a different torrent after a handover, and a `remove` carrying a
// handle from the previous session would delete the wrong torrent's files. Every envelope
// carries the generation it belongs to, and the leader ignores anything stamped with another
// one. This is the only thing standing between a handover and real data loss.
export type Generation = string

export type Envelope =
  // A follower's command, addressed to whichever tab currently holds the lock.
  | { to: 'leader', from: string, gen: Generation | null, msg: any }
  // A leader broadcast. BroadcastChannel does not deliver to the posting context, so the
  // leader's own client never sees these and does not need to filter them out.
  | { to: 'all', gen: Generation, msg: any }

const randomId = (): string =>
  // randomUUID needs a secure context, which the app always has, but a fallback keeps a
  // plain-http dev server from failing at import time.
  globalThis.crypto?.randomUUID?.() ?? `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

export const newClientId = randomId
export const newGeneration = randomId

export const hasWebLocks = (): boolean => typeof navigator !== 'undefined' && !!navigator.locks

// How the client reaches the engine, whichever side of the election this tab is on. The
// client is written once against this, so the borrowed path and the owned path cannot drift
// apart in their handling of reads, latching or errors.
export type TransportHost = {
  message: (msg: any) => void
  // `fatal` means nothing will ever work here, as opposed to one command going wrong.
  error: (message: string, fatal: boolean) => void
}

export type Transport = {
  post: (msg: any, transfer: Transferable[]) => void
  destroy: () => void
}

// `docId` names the tab, not the transport, so the id the engine sees on a follower's
// envelopes is the same one prefixing the viewer ids that tab's players hand out. That is
// what lets the leader clean up after a tab that closed mid-playback.
export type TransportFactory = (host: TransportHost, docId: string) => Transport

// Raw worker messages a follower needs to see. Read replies are excluded on purpose: those
// belong to whoever asked, and go to that tab's own channel.
//
// A fourth allowlist with the same silent-drop failure as the worker's OWN, so
// worker-protocol.test.ts checks this one against the client's handlers too.
export const BROADCAST_TYPES = new Set([
  'ready', 'state', 'list', 'storage-unavailable', 'add-failed', 'worker-error', 'error', 'fatal',
])

// Everything the follower knew belonged to an engine that no longer exists: the handles in
// its latched state, the reads it is waiting on, and any error it is showing. Synthesised by
// the transport on a generation change, never sent by a worker.
export const ENGINE_RESET = 'engine-reset'

// The leader's worker posts state on a fixed 500ms tick whether or not anything moved, so a
// broadcast doubles as a heartbeat. Past this much silence a follower assumes there is no
// leader and holds commands rather than posting them into a gap where nobody is listening.
//
// Ten ticks of headroom. Real browsers hold the 500ms interval closely, measured in both
// Chromium and Firefox and unaffected by backgrounding the tab, so this is slack for a busy
// main thread rather than for throttling. (Playwright's headless Firefox does throttle it
// hard, which is worth knowing when a test that watches the engine looks flaky, but no real
// browser behaves that way.) Deciding a leader is gone is cheap, since any later broadcast
// marks it up again and releases what was held; the expensive mistake is the other one,
// posting a command into a gap where nobody is listening and it is simply lost.
export const LEADER_SILENCE_MS = 5_000
