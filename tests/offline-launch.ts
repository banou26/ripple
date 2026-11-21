import type { LaunchOptions } from '@playwright/test'

export const CHROMIUM_OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'

/*
 * Firefox has no Chromium-style host resolver flag, so non-local traffic goes to a dead loopback SOCKS5 proxy with
 * remote DNS and DoH off. Measured 2026-11-22 on Firefox 1555: fetch to a host, IPv4 or IPv6 literal, WebSocket,
 * WebTransport and cross-origin iframes all fail in under 10 ms, while localhost, 127.0.0.1, [::1] and Playwright's
 * route() still work.
 */
export const FIREFOX_OFFLINE: Readonly<Record<string, string | number | boolean>> = {
  'network.proxy.type': 1,
  'network.proxy.socks': '127.0.0.1',
  'network.proxy.socks_port': 1,
  'network.proxy.socks_version': 5,
  'network.proxy.socks_remote_dns': true,
  'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, ::1',
  'network.proxy.allow_hijacking_localhost': false,
  'network.trr.mode': 5,
}

/**
 * Adds the browser's offline block under whatever `launchOptions` the project or spec set, keeping `executablePath`,
 * mute flags and every other option intact. The offline block goes first so a spec that names rules or prefs of its
 * own replaces it.
 */
export const offlineLaunchOptions = (browserName: string, launchOptions: LaunchOptions = {}, deployed = false): LaunchOptions => {
  if (deployed) return launchOptions
  if (browserName === 'chromium') return { ...launchOptions, args: [CHROMIUM_OFFLINE, ...(launchOptions.args ?? [])] }
  if (browserName === 'firefox') return { ...launchOptions, firefoxUserPrefs: { ...FIREFOX_OFFLINE, ...launchOptions.firefoxUserPrefs } }
  return launchOptions
}
