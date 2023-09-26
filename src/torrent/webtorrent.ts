import { Instance } from '@types/webtorrent'

import { TorrentDocument, torrentCollection } from './collection'
import { database, leaderElector } from './database'
import WebTorrent from 'webtorrent/dist/webtorrent.min.js'

const webtorrent = new WebTorrent({
  trackers: []
}) as Instance

console.log('webtorrent', webtorrent)

const addTorrent = async (torrentDoc: TorrentDocument) => {
  console.log('addTorrent', torrentDoc)
  const { torrentFile } = torrentDoc
  if (!torrentFile) throw new Error('torrent file and magnet not set')

  console.log('adding torrent: ', torrentFile)
  const torrent = webtorrent.add(
    torrentFile,
    {
      path: torrentFile.name,
      announce: [
        'd3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg==',
        'd3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl',
        'aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'
      ].map(atob)
    }
  )
  console.log('torrent', torrent)
  torrent.on('done', () => {
    console.log('done')
    torrentDoc.incrementalModify((doc) => {
      doc.status = torrent.paused ? 'finished' : 'seeding'
      return doc
    })
  })
  torrent.on('download', () => {
    console.log('download')
    torrentDoc.incrementalModify((doc) => {
      doc.progress = torrent.progress
      return doc
    })
  })
  torrent.on('error', (err) => {
    console.error(err)
  })
  torrent.on('infoHash', () => {
    console.log('infoHash')
    torrentDoc.incrementalModify((doc) => {
      doc.infoHash = torrent.infoHash
      return doc
    })
  })
  torrent.on('metadata', () => {
    console.log('metadata')
    torrentDoc.incrementalModify((doc) => {
      doc.name = torrent.name
      return doc
    })
  })
  torrent.on('ready', () => {
    console.log('ready')
    torrentDoc.incrementalModify((doc) => {
      doc.status =
        torrent.done ? 'finished' :
        torrent.paused ? 'paused' :
        'downloading'
      return doc
    })
  })
  // torrent.on('warning', (err) => {
  //   console.warn(err)
  // })
  torrent.on('wire', (wire) => {
    torrentDoc.incrementalModify((doc) => {
      doc.peers = torrent.numPeers
      return doc
    })
    console.log('wire', wire)
  })
  torrent.on('download', () => {
    console.log('download', torrent.progress)
  })
  torrent.on('upload', () => {
    console.log('upload', torrent.progress)
  })
  torrent.on('noPeers', (announceType) => {
    torrentDoc.incrementalModify((doc) => {
      doc.peers = torrent.numPeers
      return doc
    })
    console.log('noPeers', announceType)
  })
}

database
  .waitForLeadership()
  .then(() => {
    console.log('The current tab has been elected as leader')

    torrentCollection
      .find()
      .$
      .subscribe(async (torrentFiles) => {
        console.log('torrents', torrentFiles)

        for (const torrentFile of torrentFiles) {
          if (await webtorrent.get(torrentFile.infoHash)) {
            console.log('torrent already set', torrentFile.infoHash)
            continue
          }
          await addTorrent(torrentFile)
        }
      })
  })


leaderElector.onduplicate = async () => {
  console.log('Another leader-elector instance has been found.')
  window.location.reload()
}
