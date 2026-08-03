// The leader holds a Web Lock whose callback never resolves, and the browser releases it when
// the holder closes. Only ever promotes: handing the engine back would tear down a live session.

import { ENGINE_LOCK } from './engine-protocol'

export type Election = {
  elected: Promise<void>
  isLeader: () => boolean
  abandon: () => void
}

export const electEngineOwner = (): Election => {
  const controller = new AbortController()
  let leader = false
  let settle!: () => void
  // the only way to hand a held lock back: aborting after the callback started does nothing
  let release: () => void = () => {}
  const elected = new Promise<void>((resolve) => { settle = resolve })

  navigator.locks
    .request(ENGINE_LOCK, { mode: 'exclusive', signal: controller.signal }, () => {
      leader = true
      settle()
      return new Promise<void>((resolve) => { release = resolve })
    })
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
