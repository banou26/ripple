// Which tab owns the engine, decided by a Web Lock.
//
// The elected tab requests the lock with a callback that never resolves, so it holds it
// until the tab goes away. The browser releases a lock when its holder closes or crashes,
// which is what makes this safe without heartbeats or timeouts: there is no interval long
// enough to be certain a silent tab is dead, and no interval short enough to avoid a false
// handover on a throttled background tab. The lock has neither problem.
//
// Only ever promotes. A tab that wins the lock keeps it, because handing the engine back
// would mean tearing down a live session and every read running through it, and nothing
// asks for that.

import { ENGINE_LOCK } from './engine-protocol'

export type Election = {
  // Resolves when this tab becomes the leader, which may be immediately (no other tab) or
  // much later (when the current leader closes). Never rejects.
  elected: Promise<void>
  isLeader: () => boolean
  // Stops waiting. Releases the lock if this tab holds it, so another tab can take over.
  abandon: () => void
}

export const electEngineOwner = (): Election => {
  const controller = new AbortController()
  let leader = false
  let settle!: () => void
  // Resolving this is the only way to hand a held lock back: aborting the signal after the
  // callback has started is defined as having no effect.
  let release: () => void = () => {}
  const elected = new Promise<void>((resolve) => { settle = resolve })

  navigator.locks
    .request(ENGINE_LOCK, { mode: 'exclusive', signal: controller.signal }, () => {
      leader = true
      settle()
      // Held until this tab is gone, or until release() is called.
      return new Promise<void>((resolve) => { release = resolve })
    })
    // An abort rejects, and so does a lock manager that refuses for any other reason. Either
    // way this tab simply never leads, which the app already has to cope with.
    .catch(() => {})

  return {
    elected,
    isLeader: () => leader,
    abandon: () => {
      if (leader) { leader = false; release() }
      else controller.abort()
    },
  }
}
