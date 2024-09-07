import type { RxCollection, RxDocument } from 'rxdb'
import type { Torrent, TorrentFile, TorrentOptions } from 'webtorrent'

import { Buffer } from 'buffer' 
import ParseTorrent from 'parse-torrent'
import { LRUCache } from 'lru-cache'
import { useEffect, useState } from 'react'

import { database } from './rxdb'
import { client } from '../webtorrent'
import { getTorrentFilePieces } from './utils'
import { deleteDB } from 'idb'

export type TorrentDocument = {
  infoHash: string
  embedded: boolean
  options: {
    paused: boolean
  },
  state: {
    magnet?: string
    torrentFile?: string
    addedAt: number
    files: {
      index: number
      length: number
      downloadedAt: number | undefined
      accessedAt: number
      name: string
      piecesInfo: {
        index: number
        start: number
        end: number
        startPieceIndex: number
        endPieceIndex: number
        isStartPieceMultiFile: boolean
        isEndPieceMultiFile: boolean
      }
    }[]
  }
}

export type TorrentCollection = RxCollection<TorrentDocument>

const tryAddCollection = () =>
  database
    .addCollections({
      torrents: {
        schema: {
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
            embedded: {
              type: 'boolean'
            },
            state: {
              type: 'object',
              properties: {
                magnet: {
                  type: 'string',
                  maxLength: 32768 // 2**15
                },
                torrentFile: {
                  type: 'string'
                },
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: {
                        type: 'number'
                      },
                      length: {
                        type: 'number'
                      },
                      downloadedAt: {
                        type: 'number'
                      },
                      accessedAt: {
                        type: 'number'
                      },
                      name: {
                        type: 'string'
                      },
                      piecesInfo: {
                        type: 'object',
                        properties: {
                          index: {
                            type: 'number'
                          },
                          start: {
                            type: 'number'
                          },
                          end: {
                            type: 'number'
                          },
                          startPieceIndex: {
                            type: 'number'
                          },
                          endPieceIndex: {
                            type: 'number'
                          },
                          isStartPieceMultiFile: {
                            type: 'boolean'
                          },
                          isEndPieceMultiFile: {
                            type: 'boolean'
                          },
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          required: ['infoHash']
        }
      }
    })
    .catch(async err => {
      console.warn('RXDB DB creation errored, clearing IDB instances')
      console.error(err)
      const rxDBs =
        (await indexedDB.databases())
          .filter(dbInfo => dbInfo.name?.startsWith('rxdb-'))

      await Promise.all(
        rxDBs.map(rxDB => deleteDB(rxDB.name!))
      )
      await new Promise(resolve => setTimeout(resolve, 1000))
      return tryAddCollection()
    })
    .then(({ torrents }) => torrents as unknown as Promise<TorrentCollection>)

export const torrentCollection = tryAddCollection()
  

const _torrentCollection = torrentCollection

type TorrentFileEmbeddedLRURankItem = {
  torrentDocument: RxDocument<TorrentDocument>
  infoHash: string
  fileIndex: number
  length: number
  downloadedAt: number
  accessedAt: number
}

const opfsRoot = navigator.storage.getDirectory()
const _torrentFolder = opfsRoot

const clearEmbeddedTorrentsOffLRURank = async () => {
  const torrentFolder = await _torrentFolder
  const torrentCollection = await _torrentCollection
  const torrentDocuments = await torrentCollection.find({}).exec()
  const embeddedTorrentFiles =
    torrentDocuments
      .filter(torrent => torrent.embedded)
      .flatMap(torrent =>
        torrent.state.files.map((torrentFileRankItem, index) => ({
          torrentDocument: torrent,
          infoHash: torrent.infoHash,
          fileIndex: index,
          downloadedAt: torrentFileRankItem.downloadedAt,
          accessedAt: torrentFileRankItem.accessedAt,
          length: torrentFileRankItem.length
        }) as TorrentFileEmbeddedLRURankItem)
      )
  const sortedEmbeddedTorrentFiles =
    embeddedTorrentFiles
      .filter((torrentFileRankItem): torrentFileRankItem is TorrentFileEmbeddedLRURankItem & { accessedAt: number } =>
        torrentFileRankItem.accessedAt !== undefined
      )
      .sort((a, b) => a.accessedAt - b.accessedAt)

  const storageEstimate = await navigator.storage.estimate()
  const cache = new LRUCache<string, TorrentFileEmbeddedLRURankItem>({
    maxSize: Math.min(storageEstimate.quota! - 10_000_000, 25_000_000_000),
    sizeCalculation: (torrentFile) => torrentFile.length,
    dispose: async (torrentFile) => {
      const torrentFileState = torrentFile.torrentDocument.state.files[torrentFile.fileIndex]
      if (!torrentFileState) throw new Error('torrentFileState not found')
      const torrent = await client.get(torrentFile.infoHash)
      const torrentFileInstance = torrent?.files.find((_, index) => index === torrentFile.fileIndex)
      if (torrentFileInstance) {
        torrentFileInstance.deselect()
      }
      // todo: handle torrent batches
      const fileFolderName = `${torrentFileState.name} - ${torrentFile.infoHash.slice(0, 8)}`
      const opfsFolder = await torrentFolder.getDirectoryHandle(fileFolderName)
      const piecesArray =
        new Array(torrentFileState.piecesInfo.endPieceIndex - torrentFileState.piecesInfo.startPieceIndex)
          .fill(undefined)
          .map((_, index) => index + torrentFileState.piecesInfo.startPieceIndex)
      await Promise.all(
        piecesArray.map(async (pieceIndex, index) => {
          if (
            torrentFileState.piecesInfo.isStartPieceMultiFile
            && index - torrentFileState.piecesInfo.startPieceIndex === pieceIndex
          ) {
            return
          }
          await opfsFolder.removeEntry(pieceIndex.toString())
        })
      )

      const isUniqueFileDownloaded =
        torrentFile.torrentDocument.state.files.length > 1
          ? (
            torrentFile
              .torrentDocument
              .state
              .files
              .some(file =>
                file !== torrentFileState
                && file.downloadedAt !== undefined
              )
          )
          : true
      if (isUniqueFileDownloaded) {
        await torrentFolder.removeEntry(fileFolderName, { recursive: true })
        if (torrent) {
          torrent.destroy()
        }
      }
    }
  })

  for (const torrentFileRankItem of sortedEmbeddedTorrentFiles) {
    cache.set(torrentFileRankItem.infoHash, torrentFileRankItem)
  }

  const allOPFSFolders = await torrentFolder.entries()
  for await (const [folderName, folderHandle] of allOPFSFolders) {
    if (folderHandle.kind !== 'directory') continue
    const opfsFolderName = folderHandle.name
    if (
      torrentDocuments.some(torrent =>
        torrent.state.files.some(file =>
          `${file.name} - ${torrent.infoHash.slice(0, 8)}` === opfsFolderName
        )
      )
    ) {
      continue
    }
    await torrentFolder.removeEntry(opfsFolderName, { recursive: true })
  }

  return [...cache.values()]
}

export const parseTorrentInput = (options: { torrentFile: Uint8Array } | { magnet: string }): ParseTorrent.Instance =>
  'magnet' in options
    ? ParseTorrent(options.magnet) as ParseTorrent.Instance
    : ParseTorrent(options.torrentFile)

export const addTorrent = async (
  options:
    ({ torrentFile: Uint8Array } | { magnet: string })
    & { embedded?: boolean, fileIndex?: number },
  wtOptions?: TorrentOptions,
  callback?: (torrent: Torrent) => any
) => {
  const torrentCollection = await _torrentCollection
  const parsedTorrent = await parseTorrentInput(options)
  const infoHash = parsedTorrent.infoHash
  
  const foundTorrent = await torrentCollection.findOne({ selector: { infoHash } }).exec()

  const input =
    foundTorrent?.state.torrentFile
      ? Buffer.from(foundTorrent.state.torrentFile, 'base64')
      : parsedTorrent as ParseTorrent.Instance

  const torrent = client.add(input, { ...wtOptions }, callback)

  if (options.embedded) {
    torrent.files.forEach((file) => file.deselect())
  }
  const selectedFile =
    options.fileIndex
      ? torrent.files[options.fileIndex]
      : undefined

  torrent.on('metadata', async () => {
    await torrentCollection.upsert(
      {
        infoHash,
        embedded:
          options.embedded
          ?? foundTorrent?.embedded
          ?? false,
        state: {
          ...foundTorrent?.state,
          magnet: foundTorrent?.state.magnet ?? torrent.magnetURI,
          torrentFile: Buffer.from(torrent.torrentFile).toString('base64'),
          addedAt: foundTorrent?.state.addedAt ?? Date.now(),
          files: await Promise.all(
            torrent.files.map(async (file, index) => ({
              index,
              length: file.length,
              downloadedAt:
                foundTorrent
                  ?.state
                  .files
                  ?.[index]
                  ?.downloadedAt
                ?? (
                  options.fileIndex === index
                    ? Date.now()
                    // means the file wasn't downloaded
                    : undefined
                ),
              name: file.name,
              accessedAt: Date.now(),
              piecesInfo: await getTorrentFilePieces(torrent, index)
            }))
          )
        }
      }
    )

    await clearEmbeddedTorrentsOffLRURank()

    if (selectedFile) {
      selectedFile.select()
    }
  })

  return torrent
}

export const useTorrent = (
  options:
    ({ torrentFile?: Uint8Array } | { magnet?: string })
    & { embedded?: boolean, fileIndex?: number, disabled: boolean }
) => {
  const [torrent, setTorrent] = useState<Torrent>()

  useEffect(() => {
    if (options.disabled) return
    addTorrent(
      'torrentFile' in options ? { ...options, torrentFile: options.torrentFile! }
      : 'magnet' in options ? { ...options, magnet: options.magnet! }
      : undefined as never
    )
      .then(torrent =>
        torrent.on(
          'ready',
          () => setTorrent(torrent)
        )
      )
      
  }, [options.disabled])

  return torrent
}
