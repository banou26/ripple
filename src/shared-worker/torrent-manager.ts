import type { TorrentDocument } from '../database'

import type { RxDocument } from 'rxdb'
import { torrent } from '@fkn/lib'

import { torrentCollection } from '../database'
import { throttleStream } from './utils'

const managedTorrentList = new Map<string, ReturnType<typeof makeManagedTorrent>>()
const managedDownloadList = new Map<string, ReturnType<typeof makeManagedDownload>>()
const managedFileDownloadList = new Map<string, ReturnType<typeof makeManagedFileDownload>>()

const makeManagedFileDownload = (torrentDoc: RxDocument<TorrentDocument>, fileDoc: NonNullable<TorrentDocument['state']['files']>[number]) => {
  if (managedFileDownloadList.has(fileDoc.path)) return managedFileDownloadList.get(fileDoc.path)

  const responsePromise = torrent(torrentDoc.infoHash, fileDoc.path) as Promise<Response>
  const readerPromise = responsePromise.then(response => {
    if (!response.body) throw new Error('no body')
    return throttleStream(response.body, 100_000).getReader()
  })

  readerPromise.then((reader) => {
    if (!reader) return
    const read = async () => {
      const { done, value } = await reader.read()
      if (done) return
      console.log(value)
      read()
    }
    read()
  })

  const result = {
    interrupt: () => {
      readerPromise.then(reader => reader?.cancel())
      managedFileDownloadList.delete(fileDoc.path)
      torrentDoc.update({ $set: { 'state.files': { $pull: [fileDoc.path] } } })
    }
  }

  managedFileDownloadList.set(fileDoc.path, result)
  return result
}

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
