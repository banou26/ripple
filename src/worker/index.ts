import { makeCallListener, registerListener } from 'osra'
import { torrentCollection } from '../database'

console.log('WORKER')
const init = makeCallListener(async ({ magnet }: { magnet: string }) => {

  return magnet
})

const resolvers = {
  init
}

export type Resolvers = typeof resolvers

registerListener({
  target: globalThis as unknown as Worker,
  resolvers
})


globalThis.addEventListener('connect', ({ ports: [port] }) => {
  console.log('message', port)
  port.postMessage('init')
})
