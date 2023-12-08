import { Instance } from 'parse-torrent'
import { Buffer } from 'buffer'

import { TorrentDocument } from './schema'

export const serializeTorrentFile = (torrentFile: Instance): TorrentDocument => ({
  ...torrentFile,
  created: torrentFile.created?.getTime(),
  info: torrentFile.info && {
    ...torrentFile.info,
    files: torrentFile.info.files && torrentFile.info.files.map((file) => ({
      ...file,
      path: file.path.map(path => Buffer.from(path).toString('utf-8'))
    })),
    name: Buffer.from(torrentFile.name).toString('utf-8'),
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
      path: file.path
    })),
    name: torrentFile.info.name,
    pieces: new Uint8Array(Buffer.from(torrentFile.info.pieces, 'base64'))
  },
  infoBuffer: new Uint8Array(Buffer.from(torrentFile.infoBuffer, 'base64')),
  infoHashBuffer: new Uint8Array(Buffer.from(torrentFile.infoHashBuffer, 'base64'))
})

export const serializeTorrentDocumentState = (state: Partial<TorrentDocument['state']>): TorrentDocument['state'] => ({
  magnet: state.magnet,
  path: state.path,
  pieces: state.pieces,
  name: state.torrentFile?.name || '',
  status: state.status ?? 'checkingFiles',
  progress: state.progress ?? 0,
  size: state.torrentFile?.length || 0,
  peers: [],
  // proxy: state.proxy ?? false,
  // p2p: state.p2p ?? false,
  addedAt: state.addedAt ?? Date.now(),
  remainingTime: state.remainingTime ?? 0,
  peersCount: state.peersCount ?? 0,
  seedersCount: state.seedersCount ?? 0,
  leechersCount: state.leechersCount ?? 0,
  downloaded: state.downloaded ?? 0,
  uploaded: state.uploaded ?? 0,
  downloadSpeed: state.downloadSpeed ?? 0,
  uploadSpeed: state.uploadSpeed ?? 0,
  ratio: state.ratio ?? 0,
  files: state.files ?? (
    state.torrentFile?.files?.map((file, index) => ({
      index,
      status: 'checking',
      name: file.name,
      path: file.path,
      pathArray: state.torrentFile?.info?.files?.[index]?.path ?? file.path.split('/'),
      offset: file.offset,
      length: file.length,
      downloaded: 0,
      progress: 0,
      selected: true,
      priority: 1,
      downloadedRanges: [],
      downloadSpeed: 0,
      streamBandwithLogs: []
    }))
  ),
  streamBandwithLogs: state.streamBandwithLogs ?? [],
  torrentFile: state.torrentFile
})

export const serializeTorrentDocument = (torrentDocument: Pick<TorrentDocument, 'infoHash'> & Partial<TorrentDocument>): TorrentDocument => ({
  infoHash: torrentDocument.infoHash,
  options: {
    paused: torrentDocument.options?.paused ?? false
  },
  state: serializeTorrentDocumentState(torrentDocument.state ?? {})
})

export const deserializeTorrentDocument = (torrentDocument: TorrentDocument): TorrentDocument => ({
  ...torrentDocument,
  state: {
    ...torrentDocument.state,
  }
})
