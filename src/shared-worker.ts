import { makeCallListener, registerListener } from 'osra'

import { getApiTarget, getApiTargetPort } from '@fkn/lib'

import WorkerURL from './shared-worker/index?worker&url'

export type Resolvers = typeof resolvers

const worker = new SharedWorker(WorkerURL, { type: 'module' })

export const { resolvers } = registerListener({
  resolvers: {
    getApiTargetPort: makeCallListener(() => getApiTargetPort())
  },
  target: worker.port as unknown as Window,
  key: 'shared-worker-fkn-api',
  proxyTarget: await getApiTarget()
})

worker.port.addEventListener('error', (err) => {
  console.error(err)
})

worker.port.start()

export default worker
