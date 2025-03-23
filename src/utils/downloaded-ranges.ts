import { DownloadedRange } from '@banou/media-player/src/utils/context'

/**
 * Converts a WebTorrent bitfield to downloaded byte ranges for a specific file.
 * 
 * @param bitfield The WebTorrent bitfield
 * @param pieceLength The length of each piece in bytes
 * @param torrentLength The total size of the torrent in bytes
 * @param fileOffset The byte offset of the file within the torrent
 * @param fileLength The length of the file in bytes
 * @returns Array of downloaded ranges with start and end byte offsets relative to the file
 */
export function getBytesRangesFromBitfield(
  bitfield: any, 
  pieceLength: number, 
  torrentLength: number,
  fileOffset: number,
  fileLength: number
): DownloadedRange[] {
  const ranges: DownloadedRange[] = []
  
  if (!bitfield || fileLength === 0) return ranges

  // Calculate file boundaries in the torrent
  const fileEndOffset = fileOffset + fileLength
  
  // Calculate which pieces overlap with the file
  const firstPieceIndex = Math.floor(fileOffset / pieceLength)
  const lastPieceIndex = Math.ceil(fileEndOffset / pieceLength) - 1
  
  let startPiece = -1
  const numPieces = Math.ceil(torrentLength / pieceLength)
  
  const isPieceDownloaded = (index: number): boolean => {
    if (index >= numPieces) return false
    
    if (typeof bitfield.get === 'function') {
      return bitfield.get(index)
    } 
    else {
      const byteIndex = Math.floor(index / 8)
      const bitOffset = index % 8
      if (byteIndex >= bitfield.length) return false
      return !!(bitfield[byteIndex] & (1 << (7 - bitOffset)))
    }
  }
  
  function addRange(startPiece: number, endPiece: number) {
    // Calculate the absolute byte offsets in the torrent
    const startByteOffsetInTorrent = startPiece * pieceLength
    const endByteOffsetInTorrent = Math.min(endPiece * pieceLength, torrentLength)
    
    // Skip if the range is completely outside the file
    if (startByteOffsetInTorrent >= fileEndOffset || endByteOffsetInTorrent <= fileOffset) {
      return
    }
    
    // Calculate the overlapping part of the range with the file
    const startByteOffset = Math.max(startByteOffsetInTorrent, fileOffset) - fileOffset
    const endByteOffset = Math.min(endByteOffsetInTorrent, fileEndOffset) - fileOffset
    
    ranges.push({ startByteOffset, endByteOffset })
  }
  
  // Only iterate through pieces that could potentially overlap with the file
  for (let i = firstPieceIndex; i <= Math.min(lastPieceIndex + 1, numPieces); i++) {
    if (isPieceDownloaded(i) && startPiece === -1) {
      startPiece = i
    } else if ((!isPieceDownloaded(i) || i === Math.min(lastPieceIndex + 1, numPieces)) && startPiece !== -1) {
      addRange(startPiece, i)
      startPiece = -1
    }
  }
  
  return ranges
}
