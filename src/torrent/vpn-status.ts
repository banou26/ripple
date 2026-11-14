import type { Reachability } from './client'
import type { EngineTransport } from './vpn-config'

import { defineMessages } from 'react-intl'

import { intl } from '../i18n'

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
 * UNREACHABLE is an engine behind the relay with neither: nothing is carrying anything, and every
 * torrent sits on "Loading torrent…" with zero peers and no error anywhere on screen. That is the
 * state this readout was built to name.
 *
 * OFF is the person's choice, and nothing failed: the engine runs with no relay and its peers are
 * the browser's own WebRTC connections.
 *
 * WAITING is a choice the engine has yet to follow. It is replaced by one on the other transport,
 * and that waits while a page saves a file, which a new engine would end.
 */
export type VpnState = 'on' | 'healing' | 'unreachable' | 'off' | 'waiting'

export type VpnStatus = {
  state: VpnState
  /** One WORD, because colour is never allowed to be the only thing separating these states. */
  label: string
  /** One line for the state that needs acting on, or null where the label says it all. */
  detail: string | null
}

const LABEL = defineMessages<VpnState>({
  on: { id: 'On', defaultMessage: 'On' },
  healing: { id: 'Reconnecting', defaultMessage: 'Reconnecting' },
  unreachable: { id: 'Unreachable', defaultMessage: 'Unreachable' },
  off: { id: 'Off', defaultMessage: 'Off' },
  waiting: { id: 'Waiting', defaultMessage: 'Waiting' },
})

/** The word of every state, in the language in use: the room a readout keeps so that a change of state moves nothing. */
export const vpnLabels = (): string[] => Object.values(LABEL).map((label) => intl.formatMessage(label))

/**
 * Null while the engine has said nothing: not knowing is not the same as off. `wanted` is the stored choice of
 * the VPN, where the caller draws a switch: an engine on the other transport reads as waiting.
 */
export const vpnStatus = (reachable: Reachability | null, transport?: EngineTransport | null, wanted?: boolean): VpnStatus | null => {
  const answer = (state: VpnState, detail: string | null = null): VpnStatus => ({ state, label: intl.formatMessage(LABEL[state]), detail })
  if (wanted !== undefined && transport && (transport === 'relay') !== wanted) return answer('waiting')
  if (transport === 'direct') return answer('off')
  if (!reachable) return null
  // an engine older than this readout sends no `listeners` at all, and a missing field cannot be
  // read as a healthy one: nothing is KNOWN to be bound, so it cannot claim On
  const listeners = reachable.listeners ?? []
  if (reachable.port !== null && listeners.some((l) => l.up)) return answer('on')
  if (listeners.some((l) => l.healing)) return answer('healing')
  return answer('unreachable', intl.formatMessage({ id: 'No peers can connect. Try reloading the page.', defaultMessage: 'No peers can connect. Try reloading the page.' }))
}
