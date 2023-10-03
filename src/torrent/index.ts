import { database, leaderElector } from './database'

let isLeader =
  leaderElector
    .awaitLeadership()
    .then(() => leaderElector.isLeader)

database
  .waitForLeadership()
  .then(() => {
    isLeader = Promise.resolve(true)
  })

export const getTorrentFileStream = async (hash: string) => {
  if (!await leaderElector.hasLeader()) throw new Error('no leader')
  if (await isLeader) {
    return
  }
  const { infoHash } = torrentDoc
  if (!infoHash) throw new Error('infoHash not set')
  const torrent = webtorrent.get(infoHash)
  if (!torrent) throw new Error('torrent not found')
  const file = torrent.files.find((file) => file.path === fileDoc.path)
  if (!file) throw new Error('file not found')
  return file.createReadStream()
}
