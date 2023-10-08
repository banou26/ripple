import { makeCallListener, registerListener } from 'osra'

import { getApiTarget, getApiTargetPort } from '@fkn/lib'

import SharedWorkerURL from './shared-worker/index?worker&url'

export type Resolvers = typeof resolvers

const sharedWorker = new Worker(SharedWorkerURL, { type: 'module' })

export const { resolvers } = registerListener({
  resolvers: {
    getApiTargetPort: makeCallListener(() => getApiTargetPort())
  },
  target: sharedWorker.port as unknown as Window,
  key: 'shared-worker-fkn-api',
  proxyTarget: await getApiTarget()
})

sharedWorker.port.addEventListener('error', (err) => {
  console.error(err)
})

sharedWorker.port.start()

export default sharedWorker
