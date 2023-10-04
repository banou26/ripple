import type { RxDocument } from 'rxdb'
import type { TorrentDocument } from '../database'

import { makeCallListener, registerListener } from 'osra'

import { torrentCollection } from '../database'

console.log('WORKER')
const newLeader = makeCallListener(async ({ magnet }: { magnet: string }) => {

  return magnet
})

const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers



globalThis.addEventListener('connect', ({ ports: [port] }) => {
  console.log('port', port)
  registerListener({
    target: port as unknown as Worker,
    resolvers
  })
})

torrentCollection
  .find()
  .$
  .subscribe(async (torrentDocuments: RxDocument<TorrentDocument>[]) => {
    console.log('torrentDocuments', torrentDocuments)
    
  })
