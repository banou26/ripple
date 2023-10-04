import { database } from './database'
import { torrentSchema } from './schema'
import { deserializeTorrentFile, serializeTorrentDocument, serializeTorrentFile } from './utils'
import parseTorrent, { Instance } from 'parse-torrent'

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

export const addTorrent = async (options: { magnet: string } | { torrentFile: Instance }) => {
  const { magnet, torrentFile } = {
    magnet: 'magnet' in options ? options.magnet : undefined,
    torrentFile: 'torrentFile' in options ? options.torrentFile : undefined
  }
  const infoHash = torrentFile?.infoHash ?? parseTorrent(magnet!).infoHash
  const torrentDoc =
    serializeTorrentDocument({
      infoHash,
      state: {
        magnet,
        torrentFile
      }
    })
  await database.torrents.insert(torrentDoc)
}
