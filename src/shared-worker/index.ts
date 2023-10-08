import { call, makeCallListener, registerListener } from 'osra'
import { setApiTarget } from '@fkn/lib'

import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'

import './test'
import './torrent-manager'

const newLeader = makeCallListener(async ({ workerPort }: { workerPort: MessagePort }) => {
  console.log('newLeader', workerPort)
})

const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers

let registers: ReturnType<typeof registerListener>

globalThis.addEventListener('connect', (ev) => {
  const { ports: [port] } = ev
  port.start()

  call<SharedWorkerFknApiResolvers>(port, { key: 'shared-worker-fkn-api' })('getApiTargetPort')
    .then(port => {
      setApiTarget(port)
    })

  if (registers) registers.unregister()
  registers = registerListener({
    key: 'shared-worker-fkn-api',
    target: port as unknown as Worker,
    resolvers
  })
})
