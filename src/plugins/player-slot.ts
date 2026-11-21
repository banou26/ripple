import { useSyncExternalStore } from 'react'

/**
 * The mounted player's overlay and box, registered by `/watch` so `PluginHost` in `Pages` can portal `player` buttons
 * into the overlay and inline popup pages into the player without `embed.tsx` importing the plugin host.
 */
export type PlayerSlot = {
  overlay: HTMLElement | null
  box: HTMLElement | null
  infoHash: string | null
  file: number
  time: () => number
}

let slot: PlayerSlot | null = null
const listeners = new Set<() => void>()

export const setPlayerSlot = (next: PlayerSlot | null) => {
  slot = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const usePlayerSlot = (): PlayerSlot | null => useSyncExternalStore(subscribe, () => slot)
