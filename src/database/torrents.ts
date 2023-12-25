import type { RxCollection } from 'rxdb'

import { database } from './database'
import { TorrentDocument, torrentSchema } from './schema'
import { deserializeTorrentFile, serializeTorrentFile } from './utils'

const { torrents } = await database.addCollections({
  torrents: {
    schema: torrentSchema
  }
}).catch(err => {
  if (import.meta.env.MODE !== 'development') throw err
  
  const res = indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
  res.onsuccess = () => {
    location.reload()
  }
  throw err
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
