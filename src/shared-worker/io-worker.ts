import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'

import { call, makeCallListener, registerListener } from 'osra'
import { setApiTarget } from '@fkn/lib'

import torrentManager from './torrent-manager'

let ioWorkerPort: MessagePort

export const getIoWorkerPort = () => ioWorkerPort

export const newLeader = makeCallListener(async ({ workerPort }: { workerPort: MessagePort }) => {
  console.log('newLeader', workerPort)
  if (ioWorkerPort) {
    console.log('torrentManager WORKER.DISCONNECTED')
    torrentManager.send({ type: 'WORKER.DISCONNECTED' })
  }
  ioWorkerPort = workerPort
    console.log('torrentManager WORKER.READY')
    torrentManager.send({ type: 'WORKER.READY' })
})

export const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers
