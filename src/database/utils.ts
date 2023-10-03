import { Instance } from 'parse-torrent'
import { TorrentDocument } from './schema'

export const serializeTorrentFile = (torrentFile: Instance): TorrentDocument => ({
  ...torrentFile,
  created: torrentFile.created?.getTime(),
  info: torrentFile.info && {
    ...torrentFile.info,
    files: torrentFile.info.files && torrentFile.info.files.map((file) => ({
      ...file,
      path: file.path.map(path => Buffer.from(path).toString('base64'))
    })),
    name: Buffer.from(torrentFile.name).toString('base64'),
    pieces: Buffer.from(torrentFile.info.pieces).toString('base64')
  },
  infoBuffer: Buffer.from(torrentFile.infoBuffer).toString('base64'),
  infoHashBuffer: Buffer.from(torrentFile.infoHashBuffer).toString('base64')
})

export const deserializeTorrentFile = (torrentFile: NonNullable<TorrentDocument['state']['torrentFile']>): Instance => ({
  ...torrentFile,
  created: torrentFile.created ? new Date(torrentFile.created) : undefined,
  info: torrentFile.info && {
    ...torrentFile.info,
    files: torrentFile.info.files && torrentFile.info.files.map((file) => ({
      ...file,
      path: file.path.map(path => new Uint8Array(Buffer.from(path, 'base64')))
    })),
    name: new Uint8Array(Buffer.from(torrentFile.info.name, 'base64')),
    pieces: new Uint8Array(Buffer.from(torrentFile.info.pieces, 'base64'))
  },
  infoBuffer: new Uint8Array(Buffer.from(torrentFile.infoBuffer, 'base64')),
  infoHashBuffer: new Uint8Array(Buffer.from(torrentFile.infoHashBuffer, 'base64'))
})

export const serializeTorrentDocument = (torrentDocument: Partial<TorrentDocument>): TorrentDocument => ({
  ...torrentDocument,
  options: {
    paused: false,
    ...torrentDocument.options
  },
  state: {
    name: torrentDocument.state?.torrentFile?.name || '',
    status: torrentDocument.state?.torrentFile ? 'downloading' : 'downloading_metadata',
    progress: 0,
    size: torrentDocument.state?.torrentFile?.length || 0,
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
    files: torrentDocument.state?.torrentFile?.files?.map((file) => ({
      ...file,
      selected: true,
      priority: 1
    })) ?? [],
    ...torrentDocument.state
  }
})

export const deserializeTorrentDocument = (torrentDocument: TorrentDocument): TorrentDocument => ({
  ...torrentDocument,
  state: {
    ...torrentDocument.state,
  }
})
