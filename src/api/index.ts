import { makeCallListener, registerListener } from 'osra'
import { BroadcastChannel, createLeaderElection } from 'broadcast-channel'

import sharedWorker from '../shared-worker'

const channel = new BroadcastChannel('ripple-api')
const elector = createLeaderElection(channel)

elector.awaitLeadership().then(() => {
  console.log('this tab is now leader')
  sharedWorker.port.postMessage('hello')
})

console.log('sharedWorker', sharedWorker)

const init = makeCallListener(async ({ magnet }: { magnet: string }) => {

  return magnet
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers

registerListener({
  target: window,
  resolvers
})
