import { WEBRTC_PEERS } from './vpn-config'

const KEY = 'ripple:vpn'

/** Whether the VPN can be switched off here at all: the feature runs and the browser has WebRTC. */
export const vpnOffAvailable = (): boolean => WEBRTC_PEERS && typeof RTCPeerConnection === 'function'

/**
 * The stored choice: On unless a person switched it off in this browser storage. Ripple's own tabs share one
 * storage, and a player embedded in another site has its own, so each keeps its own choice. An engine reads it as
 * it starts.
 */
export const vpnOn = (): boolean => {
  if (!vpnOffAvailable()) return true
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}

const stored = new Set<() => void>()

/** Stores the choice. False when the browser refused, and the choice is then unchanged. */
export const storeVpn = (on: boolean): boolean => {
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
  } catch { return false }
  for (const changed of stored) changed()
  return true
}

const REMEMBERED_KEY = 'ripple:vpn-off-remembered'

/** Whether a person asked, in this browser storage, not to be warned again when the VPN is switched off. */
export const vpnWarningRemembered = (): boolean => {
  try { return localStorage.getItem(REMEMBERED_KEY) === '1' } catch { return false }
}

/** Stores that the warning shown when the VPN is switched off is not to be shown here again. */
export const rememberVpnWarning = (): void => {
  try { localStorage.setItem(REMEMBERED_KEY, '1') } catch { /* a browser that refused is warned again */ }
}

const QUOTA_OFFER_KEY = 'ripple:quota-offer'

/** The UTC day the relay counts the FKN quota in, as a number: the quota starts again with the next one. */
export const quotaDay = (now = Date.now()): number => Math.floor(now / 86_400_000)

/**
 * Whether the offer to switch the VPN off, made once the FKN quota is used up, was answered in this browser storage
 * on the relay's current day. What is kept is the day alone, the same for everyone.
 */
export const quotaOfferAnswered = (now = Date.now()): boolean => {
  try { return localStorage.getItem(QUOTA_OFFER_KEY) === String(quotaDay(now)) } catch { return false }
}

/** Stores that the offer was answered, so it is not made again before the relay's next day. */
export const answerQuotaOffer = (now = Date.now()): void => {
  try { localStorage.setItem(QUOTA_OFFER_KEY, String(quotaDay(now))) } catch { /* a browser that refused is asked again on its next page */ }
}

/** Calls back when this page or another of this storage changes the choice. Returns the function that stops it. */
export const onVpnChange = (changed: () => void): (() => void) => {
  stored.add(changed)
  const off = onVpnStored(changed)
  return () => { stored.delete(changed); off() }
}

/** Calls back when another page of this storage changes the choice. Returns the function that stops it. */
export const onVpnStored = (changed: () => void): (() => void) => {
  // a null key is the whole storage cleared
  const listener = (event: StorageEvent) => { if (event.key === KEY || event.key === null) changed() }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
