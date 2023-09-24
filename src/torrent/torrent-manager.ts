
import { database, leaderElector } from './database'
import * as WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'


database
  .waitForLeadership()
  .then(() => {
    console.log('The current tab has been elected as leader')
  })

const webtorrent = new WebTorrent()

leaderElector.onduplicate = async () => {
  console.log('Another leader-elector instance has been found.')
}

export const addTorrent = ({ p2p, magnet, torrentFile }: ({ magnet: string } | { torrentFile: File }) & { p2p: boolean }) => {
  const torrentInfo = parseTorrent(magnet || torrentFile)
  console.log('torrentInfo', torrentInfo)
  // database.torrents.insert({
    
  // })
  // if (p2p) {
  //   webtorrent.add(magnet || torrentFile)
  // }
}
export const getTorrent = () => {

}
export const getTorrents = () => {

}
export const removeTorrent = () => {

}
