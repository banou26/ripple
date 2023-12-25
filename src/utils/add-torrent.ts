import { Buffer } from 'buffer'
import parseTorrent, { Instance } from 'parse-torrent'

import { addTorrent } from '../database/actions'

export const addTorrentFile = async (acceptedFiles: File[]) => {
  const parsedTorrents = await Promise.all(
    [
      ...await Promise.all(acceptedFiles.map(file => {
        const reader = new FileReader()
        return new Promise<Buffer>((resolve, reject) => {
          reader.onload = () => {
            if (!reader.result || !(reader.result instanceof ArrayBuffer)) return
            resolve(Buffer.from(reader.result))
          }
          reader.onerror = reject
          reader.readAsArrayBuffer(file)
        })
      }))
    ].map(parseTorrent)
  ) as Instance[]

  parsedTorrents.forEach(async torrent => {
    addTorrent({ torrentFile: torrent })
  })
}
