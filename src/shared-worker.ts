import { call, makeCallListener, registerListener, getTransferableObjects } from 'osra'

import { getApiTarget, getApiTargetPort } from '@fkn/lib'

import SharedWorkerURL from './shared-worker/index?worker&url'
import WorkerURL from './worker/index?worker&url'
import { leaderElector } from './database'

export type Resolvers = typeof resolvers

const sharedWorker = new SharedWorker(SharedWorkerURL, { type: 'module' })

//! This is needed, as we need to wait for the api to make a connection to the FKN API's worker
// todo: check WHY though, it shouldnt be needed
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
  console.log('leader')
  const worker = new Worker(WorkerURL, { type: 'module' })

  const messageChannel = new MessageChannel()
  const { port1, port2 } = messageChannel

  port1.addEventListener('message', (event) => {
    console.log('MSG PROXY TO IO WORKER', event.data)
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
