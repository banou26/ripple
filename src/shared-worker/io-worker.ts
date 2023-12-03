import type { Resolvers as IoWorkerResolvers } from '../worker'

import { call, makeCallListener } from 'osra'

import torrentManager from './torrent-manager'
import ParseTorrent from 'parse-torrent'
import { deserializeTorrentFile } from '../database/utils'

let ioWorkerPort: MessagePort

export const getIoWorkerPort = () => ioWorkerPort

export const newLeader = makeCallListener(async ({ workerPort }: { workerPort: MessagePort }) => {
  if (ioWorkerPort) {
    torrentManager.send({ type: 'WORKER.DISCONNECTED' })
  }
  ioWorkerPort = workerPort
  // todo: fix this race condition properly
  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      call(workerPort, { key: 'torrent-manager' })('ping')
        .then(res => {
          clearInterval(interval)
          resolve(undefined)
        })
    }, 100)

    call(workerPort, { key: 'torrent-manager' })('ping')
      .then(res => {
        clearInterval(interval)
        resolve(undefined)
      })

    setTimeout(() => {
      clearInterval(interval)
      reject()
    }, 1000)
  })
  torrentManager.send({ type: 'WORKER.READY' })
})

export const resolvers = {
  newLeader,
  addTorrent:
    makeCallListener(async ({ infoHash, magnet, torrentFile }: { infoHash: string, magnet: string, torrentFile: ParseTorrent.Instance | undefined }) => {
      torrentManager.send({
        type: 'TORRENT.ADD',
        input: {
          infoHash,
          magnet,
          torrentFile: torrentFile && deserializeTorrentFile(torrentFile)
        }
      })
    }),
  removeTorrent:
    makeCallListener(async ({ infoHash, removeFiles }: { infoHash: string, removeFiles: boolean }) => {
      torrentManager.send({
        type: removeFiles ? 'TORRENT.REMOVE-AND-DELETE-FILES' : 'TORRENT.REMOVE-AND-KEEP-FILES',
        input: { infoHash }
      })
    }),
  readTorrentFile: makeCallListener(({ infoHash, filePath, offset, size }: { infoHash: string, filePath: string, offset: number, size: number }) =>
    call<IoWorkerResolvers>(getIoWorkerPort(), { key: 'io-worker' })('readTorrentFile', { infoHash, filePath, offset, size })
  )
}

export type Resolvers = typeof resolvers
