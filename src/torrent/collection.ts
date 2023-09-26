import type { ExtractDocumentTypeFromTypedRxJsonSchema, RxCollection, RxDocument, RxJsonSchema } from 'rxdb'
import type { Instance } from 'parse-torrent'

import { toTypedRxJsonSchema } from 'rxdb'
import { Buffer } from 'buffer'

import { database } from './database'

export type TorrentStatus =
  'paused' |
  'checking_files' |
  'downloading_metadata' |
  'downloading' |
  'finished' |
  'seeding'
// 'idle' | 'downloading' | 'paused' | 'seeding' | 'error'

const torrentSchemaLiteral = {
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
    peers: {
      type: 'array',
      items: {
        type: 'object',
        uniqueItems: true,
        properties: {
          ip: { type: 'string' },
          port: { type: 'number' }
        }
      }
    },
    proxy: { type: 'boolean' },
    p2p: { type: 'boolean' },
    addedAt: { type: 'number' }
  },
  required: ['infoHash']
} as const

const schemaTyped = toTypedRxJsonSchema(torrentSchemaLiteral)

export type TorrentDocType = ExtractDocumentTypeFromTypedRxJsonSchema<typeof schemaTyped>

// export type TorrentDocument =
//   Exclude<ExtractDocumentTypeFromTypedRxJsonSchema<typeof schemaTyped>, 'status'> & {
//     status: TorrentStatus
//   }


export type TorrentMethods = {
  _: undefined
}

export type TorrentCollectionMethods = {
  __: undefined
}

export type TorrentDocument = RxDocument<TorrentDocType, TorrentMethods>

export const torrentSchema: RxJsonSchema<TorrentDocType> = torrentSchemaLiteral

export type Collection = RxCollection<TorrentDocument>

const { torrents: torrentCollection } = await database.addCollections({
  torrents: {
    schema: torrentSchema
  }
})

export {
  torrentCollection
}

export const serializeTorrentFile = (torrentFile: Instance): TorrentDocument => ({
  ...torrentFile,
  info: torrentFile.info && {
    ...torrentFile.info,
    name: Buffer.from(torrentFile.name).toString('base64'),
    pieces: Buffer.from(torrentFile.info.pieces).toString('base64')
  },
  infoBuffer: Buffer.from(torrentFile.infoBuffer).toString('base64'),
  infoHashBuffer: Buffer.from(torrentFile.infoHashBuffer).toString('base64')
})

export const deserializeTorrentFile = (torrentFile: TorrentDocument['torrentFile']): Instance => ({
  ...torrentFile,
  info: torrentFile.info && {
    ...torrentFile.info,
    name: new Uint8Array(Buffer.from(torrentFile.info.name, 'base64')),
    pieces: new Uint8Array(Buffer.from(torrentFile.info.pieces, 'base64'))
  },
  infoBuffer: new Uint8Array(Buffer.from(torrentFile.infoBuffer, 'base64')),
  infoHashBuffer: new Uint8Array(Buffer.from(torrentFile.infoHashBuffer, 'base64'))
})

torrentCollection.preInsert(torrent => {
  console.log('preInsert torrent', torrent)
  torrent.torrentFile = serializeTorrentFile(torrent.torrentFile)
  torrent.addedAt = Date.now()
}, true)

torrentCollection.postCreate((torrentData, rxDocument) => {
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
