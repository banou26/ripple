import { describe, expect, it } from 'vitest'

import { CHROMIUM_OFFLINE, FIREFOX_OFFLINE, offlineLaunchOptions } from './offline-launch'

describe('offlineLaunchOptions', () => {
  it('keeps Chromium launchOptions intact and puts the resolver block before spec args', () => {
    const options = offlineLaunchOptions('chromium', {
      executablePath: '/custom/chrome',
      headless: true,
      args: ['--mute-audio', '--host-resolver-rules=MAP custom.test 127.0.0.1'],
    })
    expect(options.executablePath).toBe('/custom/chrome')
    expect(options.headless).toBe(true)
    expect(options.args).toEqual([CHROMIUM_OFFLINE, '--mute-audio', '--host-resolver-rules=MAP custom.test 127.0.0.1'])
  })

  it('keeps Firefox launchOptions intact and puts the offline proxy prefs under spec prefs', () => {
    const options = offlineLaunchOptions('firefox', {
      executablePath: '/custom/firefox',
      headless: true,
      firefoxUserPrefs: {
        'media.volume_scale': '0.0',
        'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, custom.local',
      },
    })
    expect(options.executablePath).toBe('/custom/firefox')
    expect(options.headless).toBe(true)
    expect(options.firefoxUserPrefs).toEqual({
      ...FIREFOX_OFFLINE,
      'media.volume_scale': '0.0',
      'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, custom.local',
    })
  })

  it('keeps launchOptions intact against a deployed origin and on other browsers', () => {
    const base = { executablePath: '/custom/bin', args: ['--mute-audio'], firefoxUserPrefs: { 'media.volume_scale': '0.0' } }
    expect(offlineLaunchOptions('chromium', base, true)).toEqual(base)
    expect(offlineLaunchOptions('firefox', base, true)).toEqual(base)
    expect(offlineLaunchOptions('webkit', base, false)).toEqual(base)
  })
})
