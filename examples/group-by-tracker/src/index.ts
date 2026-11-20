import type { Ripple } from '@banou/ripple'

import * as packages from '@fkn/lib/packages'

import { createPlugin } from './plugin'

// fkn.app makes the payload, then hands over the connection with ripple on it, in that order for each connection
const waiting: ((ripple: Ripple) => void)[] = []

packages.onConnect<Ripple>((info) => {
  // brokered: ripple's own connection, through fkn.app, and not a page framing this one itself
  if (info.protocol !== 'ripple-plugin@1' || info.brokered !== true) throw new Error('This plugin is for Ripple')
  return createPlugin(new Promise((resolve) => { waiting.push(resolve) }))
}, (connection) => { waiting.shift()?.(connection.remote as unknown as Ripple) })
