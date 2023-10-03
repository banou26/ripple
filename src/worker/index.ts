import { makeCallListener, registerListener } from 'osra'


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

globalThis.postMessage('init')
