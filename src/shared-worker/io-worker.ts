import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'

import { call, makeCallListener, registerListener } from 'osra'
import { setApiTarget } from '@fkn/lib'

import torrentManager from './torrent-manager'

let ioWorkerPort: MessagePort

export const getIoWorkerPort = () => ioWorkerPort

const newLeader = makeCallListener(async ({ workerPort }: { workerPort: MessagePort }) => {
  if (ioWorkerPort) torrentManager.send({ type: 'WORKER.DISCONNECTED' })
  console.log('newLeader', workerPort)
  ioWorkerPort = workerPort
  torrentManager.send({ type: 'WORKER.READY' })
})

const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers

let _port: MessagePort

globalThis.addEventListener('connect', (ev) => {
  console.log('SHAREDWORKER connect', ev)
  const { ports: [port] } = ev
  port.start()
  console.log('SHAREDWORKER port', port)

  if (!_port) {
    call<SharedWorkerFknApiResolvers>(port, { key: 'shared-worker-fkn-port' })('getApiTargetPort')
      .then(port => {
        console.log('SET API TARGET PORT', port)
        setApiTarget(port)
        _port = port
      })
  }

  registerListener({
    key: 'shared-worker-fkn-api',
    target: port as unknown as Worker,
    resolvers
  })
})
