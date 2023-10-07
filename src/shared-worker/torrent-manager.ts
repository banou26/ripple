import type { TorrentDocument } from '../database'

import type { RxDocument } from 'rxdb'
import { torrent } from '@fkn/lib'

import { torrentCollection } from '../database'

const managedTorrentList = new Map<string, ReturnType<typeof makeManagedTorrent>>()
const managedDownloadList = new Map<string, ReturnType<typeof makeManagedDownload>>()

const makeManagedDownload = (torrentDoc: RxDocument<TorrentDocument>) => {
  if (managedDownloadList.has(torrentDoc.infoHash)) return managedDownloadList.get(torrentDoc.infoHash)

  const { files } = torrentDoc.state.torrentFile ?? {}
  console.log('download', torrentDoc, files)

  const result = {

    interrupt: () => {
      managedDownloadList.delete(torrentDoc.infoHash)
      torrentDoc.update({ $set: { 'state.status': 'paused' } })
    }
  }

  return result
}

const makeManagedTorrent = (torrentDoc: RxDocument<TorrentDocument>) => {
  if (managedTorrentList.has(torrentDoc.infoHash)) return managedTorrentList.get(torrentDoc.infoHash)

  const result = {

  }

  torrentDoc.$.subscribe((torrentDoc) => {
    if (torrentDoc.options.paused) {
      torrentDoc.update({ $set: { 'state.status': 'paused' } })
    } else if (!torrentDoc.options.paused && torrentDoc.state.status === 'paused') {
      torrentDoc.update({ $set: { 'state.status': 'downloading' } })
    }
    if (torrentDoc.state.status === 'downloading') {
      makeManagedDownload(torrentDoc)
    } else {
      const managedDownload = managedDownloadList.get(torrentDoc.infoHash)
      if (managedDownload) {
        managedDownloadList.interrupt(torrentDoc.infoHash)
      }
    }
  })

  console.log('torrent', torrentDoc)

  managedTorrentList.set(torrentDoc.infoHash, result)
  return result
}

torrentCollection
  .find()
  .$
  .subscribe(async (torrentDocuments: RxDocument<TorrentDocument>[]) =>
    torrentDocuments
      .map(torrentDocument => makeManagedTorrent(torrentDocument))
  )
