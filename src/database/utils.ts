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
      (piecesRanges, fileByteRange) => [
        ...piecesRanges,
        {
          ...fileByteRange,
          startPieceIndex: Math.round(fileByteRange.start / torrent.pieceLength),
          isStartPieceMultiFile: !Number.isInteger(fileByteRange.start / torrent.pieceLength),
          endPieceIndex:
            Math.round(fileByteRange.end / torrent.pieceLength) >= torrent.pieces.length - 1
              ? torrent.pieces.length - 1
              : Math.round(fileByteRange.end / torrent.pieceLength),
          isEndPieceMultiFile:
            !Number.isInteger(
              Math.round(fileByteRange.end / torrent.pieceLength) >= torrent.pieces.length - 1
                ? torrent.pieces.length - 1
                : Math.round(fileByteRange.end / torrent.pieceLength)
            )
        }
      ],
      [] as { index: number, start: number, end: number, startPieceIndex: number, endPieceIndex: number }[]
    )

  return filePieceRanges[fileIndex]!
}
