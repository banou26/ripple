import type { EngineTransport } from './vpn-config'

import { intl } from '../i18n'

/**
 * How long a download has to have had nobody connected before a surface says no peers were found.
 *
 * The first round of a search is over by then, whatever it found: the engine reads its own description within
 * 3 s, closes an offer nobody answered after 50 s and gives an answered one 30 s to open, 83 s in all, and behind
 * the relay a tracker, the DHT and a connection attempt each answer sooner. The engine keeps searching after it,
 * at the trackers' own interval.
 */
export const NO_PEERS_AFTER_MS = 90_000

/** Whether a download has gone long enough with nobody for a surface to say so. False again once a peer connects. */
export const noPeersFound = (snapshot: { noPeersSince?: number } | null | undefined, now = Date.now()): boolean =>
  snapshot?.noPeersSince !== undefined && now - snapshot.noPeersSince >= NO_PEERS_AFTER_MS

/** The one line that says it, naming the VPN where it is off: with it on, ordinary peers are in reach too. */
export const noPeersLine = (transport: EngineTransport | null | undefined): string => transport === 'direct'
  ? intl.formatMessage({ id: 'No peers found with the VPN off. Still searching.', defaultMessage: 'No peers found with the VPN off. Still searching.' })
  : intl.formatMessage({ id: 'No peers found. Still searching.', defaultMessage: 'No peers found. Still searching.' })
