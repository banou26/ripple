import { DownloadedRange } from '@banou/media-player/build/utils/context'

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
  const ranges: DownloadedRange[] = [];
  
  if (!bitfield) return ranges;

  let startPiece = -1;
  // Number of pieces in the torrent
  const numPieces = Math.ceil(torrentLength / pieceLength);
  
  // Helper function to check if a piece is downloaded
  const isPieceDownloaded = (index: number): boolean => {
    // Return false for out-of-bounds indices
    if (index >= numPieces) return false;
    
    // Use the get method if available (common in WebTorrent's BitField class)
    if (typeof bitfield.get === 'function') {
      return bitfield.get(index);
    } 
    // Otherwise handle as a raw buffer
    else {
      const byteIndex = Math.floor(index / 8);
      const bitOffset = index % 8;
      // Make sure we don't access beyond the buffer length
      if (byteIndex >= bitfield.length) return false;
      return !!(bitfield[byteIndex] & (1 << (7 - bitOffset)));
    }
  };
  
  // Helper function to add a range
  function addRange(startPiece: number, endPiece: number) {
    const startByteOffset = startPiece * pieceLength;
    const endByteOffset = Math.min(endPiece * pieceLength, torrentLength);
    
    ranges.push({ startByteOffset, endByteOffset });
  }
  
  // Find consecutive ranges of downloaded pieces
  for (let i = 0; i <= numPieces; i++) {
    if (isPieceDownloaded(i) && startPiece === -1) {
      // Start of a new range
      startPiece = i;
    } else if ((!isPieceDownloaded(i) || i === numPieces) && startPiece !== -1) {
      // End of a range
      addRange(startPiece, i);
      startPiece = -1;
    }
  }
  
  return ranges;
}

/**
 * Creates a throttled function that only executes once per specified interval,
 * but always executes with the latest arguments.
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T, 
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  let lastArgs: Parameters<T> | null = null;
  
  return function(this: any, ...args: Parameters<T>) {
    lastArgs = args;
    
    if (!inThrottle) {
      inThrottle = true;
      
      func.apply(this, lastArgs);
      
      setTimeout(() => {
        inThrottle = false;
        if (lastArgs) {
          func.apply(this, lastArgs);
        }
      }, limit);
    }
  };
}