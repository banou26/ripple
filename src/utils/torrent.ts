import type { Torrent, TorrentOptions } from 'webtorrent'
import type WebTorrentType from 'webtorrent'
import _WebTorrent from 'webtorrent/dist/webtorrent.min.js'

import ParseTorrent from 'parse-torrent'
import { createContext, useCallback, useEffect, useState } from 'react'

const WebTorrent = _WebTorrent as typeof WebTorrentType

export const webtorrent = new WebTorrent({ utp: false })
export type WebTorrent = typeof webtorrent
export const WebTorrentContext = createContext(webtorrent)

export const getTorrentFilePieces = (torrent: Torrent, fileIndex: number) => {
  const filesByteRanges =
    torrent.files.reduce(
      (fileRanges, file, index) => [
        ...fileRanges,
        {
          index,
          start: fileRanges.at(-1)?.end ?? 0,
          end: file.length + (fileRanges.at(-1)?.end ?? 0),
        }
      ],
      [] as { index: number, start: number, end: number }[]
    )

  const filePieceRanges =
    filesByteRanges.reduce(
      (piecesRanges, fileByteRange) => {
        const piecesCount = Math.ceil(fileByteRange.end / torrent.pieceLength)
        
        return [
          ...piecesRanges,
          {
            ...fileByteRange,
            startPieceIndex: Math.round(fileByteRange.start / torrent.pieceLength),
            isStartPieceMultiFile: !Number.isInteger(fileByteRange.start / torrent.pieceLength),
            endPieceIndex:
              piecesCount >= torrent.pieces.length - 1
                ? torrent.pieces.length - 1
                : piecesCount,
            isEndPieceMultiFile:
              !Number.isInteger(
                piecesCount >= torrent.pieces.length - 1
                  ? torrent.pieces.length - 1
                  : piecesCount
              )
          }
        ]
      },
      [] as {
        index: number
        start: number
        end: number
        startPieceIndex: number
        endPieceIndex: number
        isStartPieceMultiFile: boolean
        isEndPieceMultiFile: boolean
      }[]
    )

  return filePieceRanges[fileIndex]!
}

export const parseTorrentInput = (options: Partial<{ torrentFile: Uint8Array } | { magnet: string }>) =>
  options && 'magnet' in options && options.magnet ? ParseTorrent(options.magnet) as ParseTorrent.Instance
  : options && 'torrentFile' in options && options.torrentFile ? ParseTorrent(options.torrentFile)
  : undefined

export const useTorrent = (
  options:
    Parameters<typeof parseTorrentInput>[0]
    & {
      webtorrent: WebTorrent
      fileIndex?: number
      wtOptions?: TorrentOptions
      readyOn?: 'ready' | 'metadata'
    }
) => {
  const [torrent, setTorrent] = useState<Torrent>()

  const prioritizeSelectedFileOnly = useCallback(
    () => {
      if (!torrent) return
      const selectedFile =
        options.fileIndex !== undefined
          ? torrent.files[options.fileIndex]
          : undefined
      if (selectedFile) {
        // @ts-expect-error
        selectedFile.select(1)
        // @ts-expect-error
        torrent.select(selectedFile._startPiece, selectedFile._endPiece, 1)
      }
    },
    [torrent]
  )

  useEffect(() => {
    (async () => {
      const parsedTorrent = await parseTorrentInput(options)
      if (!parsedTorrent) return
      // @ts-expect-error
      const torrent = webtorrent.add(parsedTorrent, { ...options.wtOptions, deselect: true })

      torrent.on('error', err => console.error(err))
  
      torrent.on('metadata', () => {
        if (options.readyOn !== 'metadata') return
        setTorrent(torrent)
      })
  
      torrent.on('ready', () => {
        if (options.readyOn !== 'ready') return
        setTorrent(torrent)
      })
  
      if (!options.readyOn) {
        setTorrent(torrent)
      }
    })()
  }, [options.webtorrent, options.wtOptions, options.fileIndex, options.readyOn])

  useEffect(() => {
    if (!torrent) return
    const interval = setInterval(prioritizeSelectedFileOnly, 1_000)
    return () => clearInterval(interval)
  }, [torrent, prioritizeSelectedFileOnly])

  return torrent
}
