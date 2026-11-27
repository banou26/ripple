import { afterEach, describe, expect, it } from 'vitest'

import { CHROMIUM_OFFLINE, FIREFOX_OFFLINE, WEBKIT_OFFLINE, offlineLaunchOptions } from './offline-launch'

const originalWebkit = process.env.RIPPLE_WEBKIT

afterEach(() => {
  if (originalWebkit === undefined) delete process.env.RIPPLE_WEBKIT
  else process.env.RIPPLE_WEBKIT = originalWebkit
})

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

  it('strips Chromium launch options on WebKit, uses RIPPLE_WEBKIT, and applies WEBKIT_OFFLINE unless proxy is set', () => {
    delete process.env.RIPPLE_WEBKIT
    const stripped = offlineLaunchOptions('webkit', {
      executablePath: '/custom/chrome',
      headless: true,
      args: ['--mute-audio', '--disable-features=Foo'],
      ignoreDefaultArgs: ['--disable-popup-blocking'],
    })
    expect(stripped).toEqual({ headless: true, executablePath: undefined, proxy: WEBKIT_OFFLINE })

    process.env.RIPPLE_WEBKIT = '/custom/webkit'
    const withEnv = offlineLaunchOptions('webkit', { headless: true })
    expect(withEnv).toEqual({ headless: true, executablePath: '/custom/webkit', proxy: WEBKIT_OFFLINE })

    const customProxy = { server: 'socks5://127.0.0.1:9999', bypass: 'localhost' }
    const overridden = offlineLaunchOptions('webkit', { proxy: customProxy })
    expect(overridden).toEqual({ executablePath: '/custom/webkit', proxy: customProxy })
  })

  it('keeps launchOptions intact against a deployed origin and on unknown browsers', () => {
    delete process.env.RIPPLE_WEBKIT
    const base = {
      executablePath: '/custom/bin',
      args: ['--mute-audio'],
      firefoxUserPrefs: { 'media.volume_scale': '0.0' },
      proxy: { server: 'http://127.0.0.1:8888' },
    }
    expect(offlineLaunchOptions('chromium', base, true)).toEqual(base)
    expect(offlineLaunchOptions('firefox', base, true)).toEqual(base)
    expect(offlineLaunchOptions('webkit', base, true)).toEqual({
      executablePath: undefined,
      firefoxUserPrefs: { 'media.volume_scale': '0.0' },
      proxy: { server: 'http://127.0.0.1:8888' },
    })
    expect(offlineLaunchOptions('other', base, false)).toEqual(base)
  })
})
