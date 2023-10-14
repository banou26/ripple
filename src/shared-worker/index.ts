import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'

import { setApiTarget } from '@fkn/lib'
import { call, registerListener } from 'osra'

let _port: MessagePort

globalThis.addEventListener('connect', async (ev) => {
  const { resolvers } = await import('./io-worker')

  console.log('SHAREDWORKER connect', ev)
  const { ports: [port] } = ev
  
  registerListener({
    key: 'shared-worker-fkn-api',
    target: port as unknown as Worker,
    resolvers
  })

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
})
