import type { RxCollection } from 'rxdb'

import { database } from './database'
import { TorrentDocument, torrentSchema } from './schema'
import { deserializeTorrentFile, serializeTorrentDocument, serializeTorrentFile } from './utils'
import parseTorrent, { Instance, toMagnetURI } from 'parse-torrent'
import { call } from 'osra'

const { torrents } = await database.addCollections({
  torrents: {
    schema: torrentSchema
  }
})

const torrentCollection = torrents as unknown as RxCollection<TorrentDocument>

export type TorrentCollection = typeof torrentCollection
export {
  torrentCollection
}

torrentCollection.preInsert(torrent => {
  torrent.state.torrentFile = serializeTorrentFile(torrent.state.torrentFile)
  torrent.state.addedAt = Date.now()
}, true)

torrentCollection.postCreate((torrentData, rxDocument) => {
  const torrentFile = deserializeTorrentFile(torrentData.state.torrentFile)
  Object.defineProperty(
    rxDocument.state,
    'torrentFile',
    { get: () => torrentFile }
  )
})

export const addTorrent = async (options: { magnet: string } | { torrentFile: Instance }) => {
  const  { default: sharedWorker } = await import('../shared-worker')
  const { magnet, torrentFile } = {
    magnet: 'magnet' in options ? options.magnet : undefined,
    torrentFile: 'torrentFile' in options ? options.torrentFile : undefined
  }
  const infoHash = torrentFile?.infoHash ?? parseTorrent(magnet!).infoHash

  await call(sharedWorker.port, { key: 'shared-worker-fkn-api' })(
    'addTorrent',
    {
      infoHash,
      magnet,
      torrentFile: torrentFile && serializeTorrentFile(torrentFile)
    }
  )
}

export const removeTorrent = async (options: { infoHash: string, removeFiles: boolean }) => {
  const  { default: sharedWorker } = await import('../shared-worker')
  await call(sharedWorker.port, { key: 'shared-worker-fkn-api' })(
    'removeTorrent',
    {
      infoHash: options.infoHash,
      removeFiles: options.removeFiles
    }
  )
}