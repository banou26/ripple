import { call, makeCallListener } from 'osra'

import torrentManager from './torrent-manager'

let ioWorkerPort: MessagePort

export const getIoWorkerPort = () => ioWorkerPort

export const newLeader = makeCallListener(async ({ workerPort }: { workerPort: MessagePort }) => {
  console.log('newLeader', workerPort)
  if (ioWorkerPort) {
    console.log('torrentManager WORKER.DISCONNECTED')
    torrentManager.send({ type: 'WORKER.DISCONNECTED' })
  }
  ioWorkerPort = workerPort
  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      call(workerPort, { key: 'torrent-manager' })('ping')
        .then(res => {
          clearInterval(interval)
          console.log('ping', res)
          resolve(undefined)
        })
    }, 100)

    call(workerPort, { key: 'torrent-manager' })('ping')
      .then(res => {
        clearInterval(interval)
        console.log('ping', res)
        resolve(undefined)
      })

    setTimeout(() => {
      clearInterval(interval)
      reject()
    }, 1000)
  })
  console.log('torrentManager WORKER.READY')
  torrentManager.send({ type: 'WORKER.READY' })
})

export const resolvers = {
  newLeader
}

export type Resolvers = typeof resolvers
