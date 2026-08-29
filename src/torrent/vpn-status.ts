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
 * OFF is deliberately NOT reported as "using the desktop stack". `@fkn/lib/desktop` is a declared
 * placeholder in 0.9.24 whose `available()` returns false and whose every method throws, so there is
 * no second transport to fall back to yet. Off therefore means the WebVPN path is not carrying
 * anything, which is a real and diagnosable state: it is the state in which every torrent sits on
 * "Loading torrent…" with zero peers and no error anywhere on screen. That is the whole reason this
 * readout exists.
 *
 * When a desktop backend does ship, this is the place to add the third answer rather than widening
 * "off" to mean two opposite things.
 */
export type VpnState = 'on' | 'healing' | 'off'

export type VpnStatus = {
  state: VpnState
  /** One WORD, because colour is never allowed to be the only thing separating these states. */
  label: string
  /** What this state means for the download in front of the person right now. */
  detail: string
}

/**
 * What the readout itself means, as opposed to what the current state means.
 *
 * Written once and shown by every placement, because "VPN" on its own invites the reading everybody
 * already has for the word, which is a subscription tunnel somebody bought. This one is the transport
 * the browser talks to the swarm over, and that is worth one sentence wherever it appears.
 */
export const VPN_EXPLAINER =
  'On means peer traffic is going through FKN\'s WebVPN. Off means nothing is carrying it.'

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
    detail: on
      ? 'Peer traffic is going through FKN WebVPN.'
      : healing
        ? 'The WebVPN tunnel dropped and is being reclaimed.'
        : 'Nothing is carrying peer traffic. Torrents will sit on "Loading torrent…" with no peers until this reads On.',
  }
}
