
import { database, leaderElector } from './database'
import * as WebTorrent from 'webtorrent'

database
  .waitForLeadership()
  .then(() => {
    console.log('The current tab has been elected as leader')
  })

const webtorrent = new WebTorrent()

leaderElector.onduplicate = async () => {
  console.log('Another leader-elector instance has been found.')
}
