import type { Reachability } from './client'

/**
 * Whether peer traffic is going through FKN's WebVPN, as one answer three surfaces can share.
 *
 * The library strip, the download page header and the player overlay all say this now, and they have
 * to say the SAME thing: three copies of "is the tunnel up" is three chances for one of them to drift
 * and quietly reassure somebody while the other two do not. So the judgement lives here and the
 * components only decide how to draw it.
 *
 * ON means the relay reserved a port for this session AND a socket is bound and receiving on it.
 * Both halves are needed and they fail separately: `port` is the reservation and never changes for
 * the life of the session, while `listeners` is what is actually holding it right now, so a session
 * whose tunnel dropped keeps its number long after anything can reach it.
 *
 * OFF is exactly one measurement, "the WebVPN is not carrying this", and it currently covers two
 * situations that are opposite in every way that matters:
 *
 *  - In the desktop app the connections go over the machine's own network stack. Nothing is wrong.
 *  - In a plain browser there is no second transport at all. `@fkn/lib/desktop` is a declared
 *    placeholder in 0.9.24 whose `available()` returns false and whose every method throws, so off
 *    here means nothing is carrying anything: every torrent sits on "Loading torrent…" with zero
 *    peers and no error anywhere on screen. That is the state this readout was built to name.
 *
 * NOTHING IN `Reachability` SEPARATES THE TWO. When a desktop backend ships, give this a third
 * answer instead of leaving one word meaning both.
 */
export type VpnState = 'on' | 'healing' | 'off'

export type VpnStatus = {
  state: VpnState
  /** One WORD, because colour is never allowed to be the only thing separating these states. */
  label: string
  /** One line for the state that needs acting on, or null where the label says it all. */
  detail: string | null
}

/** Null while the engine has said nothing: not knowing is not the same as off. */
export const vpnStatus = (reachable: Reachability | null): VpnStatus | null => {
  if (!reachable) return null
  // an engine older than this readout sends no `listeners` at all, and a missing field cannot be
  // read as a healthy one: nothing is KNOWN to be bound, so it cannot claim On
  const listeners = reachable.listeners ?? []
  const bound = listeners.some((l) => l.up)
  const healing = listeners.some((l) => l.healing)
  const on = reachable.port !== null && bound
  const state: VpnState = on ? 'on' : healing ? 'healing' : 'off'

  return {
    state,
    label: on ? 'On' : healing ? 'Reconnecting' : 'Off',
    detail: on || healing ? null : 'No peers can connect. Try reloading the page.',
  }
}
