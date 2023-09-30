import type { RxDocument } from 'rxdb'

import type { Instance } from 'parse-torrent'

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
    addedAt: { type: 'number' },
    remainingTime: { type: 'number' },
    peersCount: { type: 'number' },
    seedersCount: { type: 'number' },
    leechersCount: { type: 'number' },
    downloaded: { type: 'number' },
    uploaded: { type: 'number' },
    downloadSpeed: { type: 'number' },
    uploadSpeed: { type: 'number' },
    ratio: { type: 'number' },
    path: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        uniqueItems: true,
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          offset: { type: 'number' },
          length: { type: 'number' },
          downloaded: { type: 'number' },
          progress: { type: 'number' },
          selected: { type: 'boolean' },
          priority: { type: 'number' }
        }
      }
    }
  },
  required: ['infoHash']
}

export type TorrentDocument = {
  infoHash: string
  magnet?: string
  torrentFile?: Instance
  name: string
  status: TorrentStatus
  progress: number
  size: number
  peers: Array<{ ip: string, port: number }>
  proxy: boolean
  p2p: boolean
  addedAt: number
  remainingTime?: number
  peersCount?: number
  seedersCount?: number
  leechersCount?: number
  downloaded?: number
  uploaded?: number
  downloadSpeed?: number
  uploadSpeed?: number
  ratio?: number
  path?: string
  files?: Array<{
    name: string
    path: string
    offset: number
    length: number
    downloaded: number
    progress: number
    selected: boolean
    priority: number
  }>
}

const { torrents: torrentCollection } = await database.addCollections({
  torrents: {
    schema: torrentSchemaLiteral
  }
})

export {
  torrentCollection
}

export const serializeTorrentFile = (torrentFile: Instance): TorrentDocument => ({
  ...torrentFile,
  created: torrentFile.created.getTime(),
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
  created: new Date(torrentFile.created),
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

export const addTorrent = async (torrentDocument: Partial<TorrentDocument>) => {
  await database.torrents.insert({
    status: torrentDocument.torrentFile ? 'downloading' : 'downloading_metadata',
    progress: 0,
    size: torrentDocument.torrentFile?.length || 0,
    peers: [],
    proxy: false,
    p2p: false,
    addedAt: Date.now(),
    remainingTime: 0,
    peersCount: 0,
    seedersCount: 0,
    leechersCount: 0,
    downloaded: 0,
    uploaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    ratio: 0,
    files: torrentDocument.torrentFile?.files?.map((file) => ({
      ...file,
      selected: true,
      priority: 1
    })) ?? [],
    ...torrentDocument
  })
}
