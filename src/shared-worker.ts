import { makeCallListener, registerListener } from 'osra'

import { getApiTarget, getApiTargetPort } from '@fkn/lib'

import WorkerURL from './shared-worker/index?worker&url'

export type Resolvers = typeof resolvers

const worker = new SharedWorker(WorkerURL, { type: 'module' })

export const { resolvers } = registerListener({
  resolvers: {
    getApiTargetPort: makeCallListener(() => {
      // console.log('RIPPLE getApiTargetPort RESOLVER')
      return getApiTargetPort()
    })
  },
  target: worker.port as unknown as Window,
  key: 'shared-worker-fkn-api',
  proxyTarget: await getApiTarget()
})

// console.log('getApiTargetPort calling')
// getApiTargetPort().then(port => {
//   console.log('-------------------port', port)
//   // worker.port.postMessage(port)
// })

worker.port.addEventListener('error', (err) => {
  console.error(err)
})

// worker.port.addEventListener('message', (event) => {
//   console.log('RIPPLE message', event.data)
// })

// console.log('loading worker', worker)

// console.log('registerListener')

// console.log('registerListener done', await getApiTarget())

worker.port.start()
// worker.port.postMessage()

export default worker
