import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'

import { setApiTarget } from '@fkn/lib'
import { call, registerListener } from 'osra'

let _port: MessagePort

globalThis.addEventListener('connect', async (ev) => {
  const { resolvers } = await import('./io-worker')

  const { ports: [port] } = ev
  
  registerListener({
    key: 'shared-worker-fkn-api',
    target: port as unknown as Worker,
    resolvers
  })

  port.start()

  if (!_port) {
    call<SharedWorkerFknApiResolvers>(port, { key: 'shared-worker-fkn-port' })('getApiTargetPort')
      .then(port => {
        setApiTarget(port)
        _port = port
      })
  }
})
