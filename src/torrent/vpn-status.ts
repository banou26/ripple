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
 *  - In the desktop app the connections go over the machine's own network stack. Nothing is wrong,
 *    which is what `VPN_EXPLAINER` describes, and it is the distinction this readout was asked for.
 *  - In a plain browser there is no second transport at all. `@fkn/lib/desktop` is a declared
 *    placeholder in 0.9.24 whose `available()` returns false and whose every method throws, so off
 *    here means nothing is carrying anything: every torrent sits on "Loading torrent…" with zero
 *    peers and no error anywhere on screen. That is the state this readout was built to name.
 *
 * NOTHING IN `Reachability` SEPARATES THE TWO, so the copy is split by job rather than by state:
 * the explainer says what on and off ARE, and `detail` below says what off COSTS, which is only
 * ever read where the cost is real. When a desktop backend ships, give this a third answer instead
 * of leaving one word meaning both.
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
 * Written once and shown by every placement, in words that assume nothing. "Peer traffic" and "the
 * tunnel" are the two phrases this used to lean on and neither means anything to somebody who has
 * simply been handed a link, which is most of the people who ever see this readout.
 *
 * It says what the two states ARE rather than what they cost, because the cost differs by where
 * ripple is running: see the note on `vpnStatus` below for why off is not always a fault.
 */
export const VPN_EXPLAINER =
  'Torrents work by connecting straight to other people\'s computers. On means those connections go '
  + 'through FKN\'s WebVPN. Off means they go over your own connection instead.'

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
      ? 'Connected. Downloads can reach other people\'s computers.'
      : healing
        ? 'The connection dropped. Ripple is getting it back, and downloads will carry on by themselves.'
        : 'Not going through the WebVPN, and nothing else here is carrying these connections, so '
          + 'torrents will sit on "Loading torrent…" with no peers until this says On. '
          + 'Try reloading the page.',
  }
}
