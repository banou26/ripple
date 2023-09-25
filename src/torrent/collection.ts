import type { Instance } from 'parse-torrent'
import type { RxDatabase, RxCollection, RxJsonSchema, RxDocument } from 'rxdb'
import { Buffer } from 'buffer'

import { database } from './database'

type TorrentStatus =
  'paused' |
  'checking_files' |
  'downloading_metadata' |
  'downloading' |
  'finished' |
  'seeding'
// 'idle' | 'downloading' | 'paused' | 'seeding' | 'error'

export type Torrent = {
  infoHash: string
  magnet?: string
  name?: string
  torrentFile?: Instance
  status?: TorrentStatus
  progress: number
  size: number
  p2p: boolean
  addedAt?: number
}

export type Collection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type TorrentDocType = Torrent

export type TorrentDocMethods = {
  // scream: (v: string) => string
}

export type TorrentDocument = RxDocument<TorrentDocType, TorrentDocMethods>

export type TorrentCollectionMethods = {
  countAllDocuments: () => Promise<number>
}

export type TorrentCollection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type MyDatabaseCollections = {
  torrents: TorrentCollection
}

export type TorrentDB = RxDatabase<MyDatabaseCollections>

const torrentSchema: RxJsonSchema<TorrentDocType> = {
  title: 'Torrent schema',
  description: 'Describes a torrent',
  version: 0,
  primaryKey: 'infoHash',
  type: 'object',
  properties: {
    infoHash: {
      type: 'string',
      maxLength: 255
    },
    magnet: { type: 'string' },
    name: { type: 'string' },
    torrentFile: { type: 'object' },
    status: { type: 'string' },
    progress: { type: 'number' },
    size: { type: 'number' },
    p2p: { type: 'boolean' },
    addedAt: { type: 'number' }
  },
  required: ['infoHash']
}

const torrentDocMethods: TorrentDocMethods = {
  // scream: function(this: TorrentDocument, what: string) {
  //   return this.id + ' screams: ' + what.toUpperCase()
  // }
}

const torrentCollectionMethods: TorrentCollectionMethods = {
  countAllDocuments: async function(this: TorrentCollection) {
    return (await this.find().exec()).length
  }
}

const { torrents } = await database.addCollections({
  torrents: {
    schema: torrentSchema,
    methods: torrentDocMethods,
    statics: torrentCollectionMethods
  }
})

export {
  torrents as torrentCollection
}

export const serializeTorrentFile = (torrentFile: Instance): TorrentDocType => ({
  ...torrentFile,
  info: torrentFile.info && {
    ...torrentFile.info,
    name: Buffer.from(torrentFile.name).toString('base64'),
    pieces: Buffer.from(torrentFile.info.pieces).toString('base64')
  },
  infoBuffer: Buffer.from(torrentFile.infoBuffer).toString('base64'),
  infoHashBuffer: Buffer.from(torrentFile.infoHashBuffer).toString('base64')
})

export const deserializeTorrentFile = (torrentFile: TorrentDocType['torrentFile']): Instance => ({
  ...torrentFile,
  info: torrentFile.info && {
    ...torrentFile.info,
    name: new Uint8Array(Buffer.from(torrentFile.info.name, 'base64')),
    pieces: new Uint8Array(Buffer.from(torrentFile.info.pieces, 'base64'))
  },
  infoBuffer: new Uint8Array(Buffer.from(torrentFile.infoBuffer, 'base64')),
  infoHashBuffer: new Uint8Array(Buffer.from(torrentFile.infoHashBuffer, 'base64'))
})

torrents.preInsert(torrent => {
  console.log('preInsert torrent', torrent)
  torrent.torrentFile = serializeTorrentFile(torrent.torrentFile)
  torrent.addedAt = Date.now()
}, true)

torrents.postCreate((torrentData, rxDocument) => {
  console.log('postCreate torrent', torrentData, rxDocument)
  const torrentFile = deserializeTorrentFile(torrentData.torrentFile)
  Object.defineProperty(
    rxDocument,
    'torrentFile',
    { get: () => torrentFile }
  )
})

export const addTorrent = async (torrentDocument: TorrentDocType) => {
  await database.torrents.insert(torrentDocument)
}
