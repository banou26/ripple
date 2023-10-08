import type { TorrentDocument } from '../database'

import type { RxDocument } from 'rxdb'
import { torrent } from '@fkn/lib'

import { torrentCollection } from '../database'
import { throttleStream } from './utils'
import parseTorrent, { toMagnetURI } from 'parse-torrent'

// todo: switch to using https://xstate.js.org/docs/

const managedTorrentList = new Map<string, ReturnType<typeof makeManagedTorrent>>()
const managedDownloadList = new Map<string, ReturnType<typeof makeManagedDownload>>()
const managedFileDownloadList = new Map<string, ReturnType<typeof makeManagedFileDownload>>()

const toFileDownloadIndex = (torrentDoc: RxDocument<TorrentDocument>, fileDoc: NonNullable<TorrentDocument['state']['files']>[number]) =>
 `${torrentDoc.infoHash}:-:${fileDoc.path}}`

const fromFileDownloadIndex = (fileDownloadIndex: string) =>
  fileDownloadIndex.split(':-:') as [string, string]



const makeManagedFileDownload = (torrentDoc: RxDocument<TorrentDocument>, fileDoc: NonNullable<TorrentDocument['state']['files']>[number]) => {
  if (managedFileDownloadList.has(toFileDownloadIndex(torrentDoc, fileDoc))) return managedFileDownloadList.get(toFileDownloadIndex(torrentDoc, fileDoc))

  console.log('torrent', torrentDoc.state.magnet, fileDoc.path)
  const responsePromise = torrent({ magnet: torrentDoc.state.magnet, path: fileDoc.path }) as Promise<Response>
  const readerPromise = responsePromise.then(response => {
    if (!response.body) throw new Error('no body')
    return throttleStream(response.body, 1_000_000).getReader()
  })

  readerPromise.then((reader) => {
    if (!reader) return
    // const read = async () => {
    //   const { done, value } = await reader.read()
    //   if (done) return
    //   console.log(value)
    //   read()
    // }
    // read()
  })

  const result = {
    interrupt: async () => {
      await readerPromise.then(reader => reader?.cancel())
      managedFileDownloadList.delete(toFileDownloadIndex(torrentDoc, fileDoc))
      torrentDoc.update({ $set: { 'state.files': { $pull: [toFileDownloadIndex(torrentDoc, fileDoc)] } } })
    }
  }

  managedFileDownloadList.set(toFileDownloadIndex(torrentDoc, fileDoc), result)
  return result
}

const makeManagedDownload = (torrentDoc: RxDocument<TorrentDocument>) => {
  if (managedDownloadList.has(torrentDoc.infoHash)) return managedDownloadList.get(torrentDoc.infoHash)
  if (!torrentDoc.state || !torrentDoc.state.torrentFile || !torrentDoc.state.files) throw new Error('Torrent document has no state')

  const { files } = torrentDoc.state

  const managedFileDownloads =
    files
      .filter(fileDoc => fileDoc.selected)
      .map(fileDoc => makeManagedFileDownload(torrentDoc, fileDoc))

  console.log('download', torrentDoc, files)

  const result = {
    interrupt: async () => {
      await Promise.all(managedFileDownloads?.map(managedFileDownload => managedFileDownload.interrupt()))
      torrentDoc.update({ $set: { 'state.status': 'paused' } })
    }
  }

  return result
}

const makeManagedTorrent = (torrentDoc: RxDocument<TorrentDocument>) => {
  if (managedTorrentList.has(torrentDoc.infoHash)) return managedTorrentList.get(torrentDoc.infoHash)

  const result = {

  }

  torrentDoc.$.subscribe(async (torrentDoc) => {
    if (torrentDoc.state.torrentFile && !torrentDoc.state.magnet) {
      torrentDoc.update({ $set: { 'state.magnet': toMagnetURI(await parseTorrent(torrentDoc.state.torrentFile)) } })
    }

    if (torrentDoc.options.paused) {
      torrentDoc.update({ $set: { 'state.status': 'paused' } })
    } else if (!torrentDoc.options.paused && torrentDoc.state.status === 'paused') {
      torrentDoc.update({ $set: { 'state.status': 'downloading' } })
    } else if (!torrentDoc.state) {
      torrentDoc.update({ $set: { 'state.status': 'downloadingMetadata' } })
    }
    if (torrentDoc.state.status === 'downloading' && torrentDoc.state) {
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
