import { DownloadedRange } from '@banou/media-player/src/utils/context'

/**
 * Converts a WebTorrent bitfield to downloaded byte ranges.
 * 
 * @param bitfield The WebTorrent bitfield
 * @param pieceLength The length of each piece in bytes
 * @param torrentLength The total size of the torrent in bytes
 * @returns Array of downloaded ranges with start and end byte offsets
 */
export function getBytesRangesFromBitfield(
  bitfield: any, 
  pieceLength: number, 
  torrentLength: number
): DownloadedRange[] {
  const ranges: DownloadedRange[] = []
  
  if (!bitfield) return ranges

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
    const startByteOffset = startPiece * pieceLength
    const endByteOffset = Math.min(endPiece * pieceLength, torrentLength)
    
    ranges.push({ startByteOffset, endByteOffset })
  }
  
  for (let i = 0; i <= numPieces; i++) {
    if (isPieceDownloaded(i) && startPiece === -1) {
      startPiece = i
    } else if ((!isPieceDownloaded(i) || i === numPieces) && startPiece !== -1) {
      addRange(startPiece, i)
      startPiece = -1
    }
  }
  
  return ranges
}
