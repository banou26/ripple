import type { Torrent } from 'webtorrent'

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
