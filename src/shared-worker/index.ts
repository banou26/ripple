import type { RxDocument } from 'rxdb'
import type { TorrentDocument } from '../database'

import { call, makeCallListener, registerListener } from 'osra'
import { setApiTarget, torrent, serverProxyFetch } from '@fkn/lib'

import type { Resolvers as SharedWorkerFknApiResolvers } from '../shared-worker'
// import { makeCallListener, registerListener, setApiTarget } from 'osra'
// import { torrent, serverProxyFetch } from '@fkn/lib'

import { torrentCollection } from '../database'

console.log('WORKER')
const newLeader = makeCallListener(async ({ magnet }: { magnet: string }) => {

  return magnet
})

const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers


// setTimeout(() => {
//   console.log('setApiTarget', setApiTarget)
// }, 2_000)

let registers: ReturnType<typeof registerListener>

globalThis.addEventListener('connect', (ev) => {
  // console.log('CONNECT')
  const { ports: [port] } = ev
  port.start()


  // console.log('RIPPLE SHARED WORKER CALL API_PORT', port)
  call<SharedWorkerFknApiResolvers>(port, { key: 'shared-worker-fkn-api' })('getApiTargetPort')
    .then(port => {
      setApiTarget(port)
    })

  // try {
  //   setApiTarget(port)
  //   registerListener({
  //     target: port as unknown as Worker,
  //     resolvers
  //   })
  // } catch (err) {
  //   console.error('err', err)
  // }
  // setApiTarget(port)
  if (registers) registers.unregister()
  registers = registerListener({
    target: port as unknown as Worker,
    resolvers
  })
  // console.log('calling serverProxyFetch')
  serverProxyFetch('https://example.com/')
    .then(res => res.text())
    .then(text => {
      console.log('text', text)
    })
    .catch(err => {
      console.error('err', err)
    })
})

// torrentCollection
//   .find()
//   .$
//   .subscribe(async (torrentDocuments: RxDocument<TorrentDocument>[]) => {
//     console.log('torrentDocuments', torrentDocuments)
//     torrent({
//       magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10',
//       path: 'Sintel.mp4'
//     })
//   })
