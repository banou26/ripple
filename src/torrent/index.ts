import { leaderElector } from './database'
import './webtorrent'


















export const getTorrentFileStream = async (hash: string, ) => {
  if (leaderElector.isLeader) {
    
  }
  const { infoHash } = torrentDoc
  if (!infoHash) throw new Error('infoHash not set')
  const torrent = webtorrent.get(infoHash)
  if (!torrent) throw new Error('torrent not found')
  const file = torrent.files.find((file) => file.path === fileDoc.path)
  if (!file) throw new Error('file not found')
  return file.createReadStream()
}
