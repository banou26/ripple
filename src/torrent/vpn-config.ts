/**
 * WebRTC peers, with the VPN on and off, and the switch between the two. False stops all of it: no WebRTC peer
 * is looked for, the engine runs behind the relay, and a stored Off reads as On. It takes effect as each page reloads.
 */
export const WEBRTC_PEERS = true

/** The two trackers a torrent is announced to beside its own. The privacy page names them. */
export const TRACKER_HOSTS = ['tracker.openwebtorrent.com', 'tracker.webtorrent.dev']
/** What tells a browser its public address with the VPN off. The privacy page names it. */
export const STUN_HOST = 'stun.l.google.com'

/**
 * The swarm rig's own tracker, which its build alone bakes in (tests/swarm-rig): on that lane every peer, tracker
 * and relay is the one machine, so the tracker stands in for the two above, no STUN host is asked, and a peer on
 * a private address is taken. Undefined in every other build.
 */
export const RIG_TRACKER: string | undefined = import.meta.env?.VITE_RIPPLE_RIG_TRACKER || undefined

/** Announced to beside a torrent's own `ws` and `wss` trackers, for every torrent that is not private. */
export const TRACKERS = RIG_TRACKER ? [RIG_TRACKER] : TRACKER_HOSTS.map((host) => `wss://${host}`)

/** Asked with the VPN off only, where the browser has to learn its own public address. */
export const ICE_SERVERS = RIG_TRACKER ? [] : [{ urls: `stun:${STUN_HOST}:19302` }]

/**
 * Every host the browser reaches by itself with the VPN off, beside the peers and the trackers a torrent names.
 * Each sees the person's IP address, so the privacy page names each.
 */
export const VPN_OFF_HOSTS = [...TRACKER_HOSTS, STUN_HOST]

/** What carries an engine's peer connections: FKN's relay, or the browser itself with the VPN off. */
export type EngineTransport = 'relay' | 'direct'
