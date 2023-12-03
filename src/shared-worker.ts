import { call, makeCallListener, registerListener, getTransferableObjects } from 'osra'

import { getApiTarget, getApiTargetPort } from '@fkn/lib'

import SharedWorkerURL from './shared-worker/index?worker&url'
import WorkerURL from './worker/index?worker&url'
import { leaderElector } from './database'

export type Resolvers = typeof resolvers

const sharedWorker = new SharedWorker(SharedWorkerURL, { type: 'module' })

// todo: THIS HELPS WITH A RACE CONDITION BUT THIS SHOULD BE FIXED
await getApiTarget()

export const { resolvers } = registerListener({
  resolvers: {
    getApiTargetPort: makeCallListener(() => getApiTargetPort())
  },
  target: sharedWorker.port as unknown as Window,
  key: 'shared-worker-fkn-port'
})

sharedWorker.port.addEventListener('error', (err) => {
  console.error(err)
})

sharedWorker.port.start()

leaderElector.awaitLeadership().then(() => {
  const worker = new Worker(WorkerURL, { type: 'module' })

  const messageChannel = new MessageChannel()
  const { port1, port2 } = messageChannel

  port1.addEventListener('message', (event) => {
    // proxyMessage({ key: 'shared-worker-fkn-api', target: worker }, event)
    const { type, data, port } = event.data
    const transferables = getTransferableObjects(data)
    worker.postMessage(
      {
        source: 'io-worker',
        type,
        data,
        port
      },
      {
        targetOrigin: '*',
        transfer: [port, ...transferables as unknown as Transferable[] ?? []]
      }
    )
  })
  port1.start()

  call(sharedWorker.port, { key: 'shared-worker-fkn-api' })('newLeader', { workerPort: port2 })
})

export default sharedWorker
