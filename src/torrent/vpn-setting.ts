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

/** Stores the choice. False when the browser refused, and the choice is then unchanged. */
export const storeVpn = (on: boolean): boolean => {
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
    return true
  } catch { return false }
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

/** Calls back when another page of this storage changes the choice. Returns the function that stops it. */
export const onVpnStored = (changed: () => void): (() => void) => {
  // a null key is the whole storage cleared
  const listener = (event: StorageEvent) => { if (event.key === KEY || event.key === null) changed() }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
