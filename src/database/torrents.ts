import type { RxCollection } from 'rxdb'
import type { Torrent, TorrentFile, TorrentOptions } from 'webtorrent'

import { Buffer } from 'buffer' 
import ParseTorrent from 'parse-torrent'
import { LRUCache } from 'lru-cache'
import { useEffect, useState } from 'react'

import { database } from './rxdb'
import { client } from '../webtorrent'
import { getTorrentFilePieces } from './utils'

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
    }[]
  }
}

export type TorrentCollection = RxCollection<TorrentDocument>

export const torrentCollection =
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
    .then(({ torrents }) => torrents as unknown as Promise<TorrentCollection>)

const _torrentCollection = torrentCollection

type TorrentFileCacheItem = { infoHash: string, fileIndex: number, downloadedAt?: number }

const getTorrentsLRUCache = async () => {
  const torrentCollection = await _torrentCollection
  const embeddedTorrents = await torrentCollection.find({ selector: { embedded: true } }).exec()
  const embeddedTorrentFiles =
    embeddedTorrents
      .flatMap(torrent =>
        torrent.state.files.map((torrentFileCacheItem, index) => ({
          infoHash: torrent.infoHash,
          fileIndex: index,
          downloadedAt: torrentFileCacheItem.downloadedAt
        }) as TorrentFileCacheItem)
      )
  const sortedEmbeddedTorrentFiles =
    embeddedTorrentFiles
      .filter((torrentFileCacheItem): torrentFileCacheItem is TorrentFileCacheItem & { downloadedAt: number } =>
        torrentFileCacheItem.downloadedAt !== undefined
      )
      .sort((a, b) => a.downloadedAt - b.downloadedAt)

  const sortedEmbeddedTorrentFilesPieces =
    await Promise.all(
      sortedEmbeddedTorrentFiles.map(async torrentFileCacheItem => ({
        ...torrentFileCacheItem,
        piecesInfo: getTorrentFilePieces(await client.get(torrentFileCacheItem.infoHash), torrentFileCacheItem.fileIndex)
      }))
    )

  console.log(sortedEmbeddedTorrentFilesPieces)

  const storageEstimate = await navigator.storage.estimate()
  const cache = new LRUCache<string, TorrentFile>({
    maxSize: storageEstimate.quota!,
    sizeCalculation: (torrentFile) => torrentFile.length
  })
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

  const torrent = client.add(input, wtOptions ?? {}, callback)

  if (options.embedded) {
    torrent.files.forEach((file) => file.deselect())
  }
  const selectedFile =
    options.fileIndex
      ? torrent.files[options.fileIndex]
      : undefined
  if (selectedFile) {
    selectedFile.select()
  }

  torrent.on(
    'ready',
    async () => {
      getTorrentsLRUCache()
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
            files: torrent.files.map((file, index) => ({
              index,
              length: file.length,
              downloadedAt:
                options.fileIndex === index
                  ? Date.now()
                  : (
                    foundTorrent
                      ?.state
                      .files
                      ?.[index]
                      ?.downloadedAt
                  )
            }))
          }
        }
      )
    }
  )

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
