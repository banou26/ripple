import { database } from './'
import { torrentSchema } from './schema'
import { deserializeTorrentFile, serializeTorrentDocument, serializeTorrentFile } from './utils'
import { Instance } from 'parse-torrent'

const { torrents: torrentCollection } = await database.addCollections({
  torrents: {
    schema: torrentSchema
  }
})

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

export const addTorrent = async ({ magnet, torrentFile }: { magnet: string, torrentFile: Instance }) => {
  await database.torrents.insert(
    serializeTorrentDocument({
      options: {
        proxy: true
      },
      state: {
        magnet,
        torrentFile
      }
    })
  )
}
