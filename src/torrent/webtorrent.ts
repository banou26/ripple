import { Instance } from '@types/webtorrent'

import { TorrentDocument, torrentCollection } from './collection'
import { database, leaderElector } from './database'
import WebTorrent from 'webtorrent/dist/webtorrent.min.js'

const webtorrent = new WebTorrent({
  trackers: []
}) as Instance

console.log('webtorrent', webtorrent)

const addTorrent = async (torrentFile: TorrentDocument) => {
  console.log('file', torrentFile)
  return
  const _torrent = torrentFile.toMutableJSON().torrentFile ?? torrentFile.magnet
  if (!_torrent) throw new Error('torrent file and magnet not set')

  console.log('adding torrent: ', _torrent)
  const torrent = webtorrent.add(
    _torrent,
    {
      path: torrentFile.name,
      announce: [
        'd3NzOi8vdHJhY2tlci5vcGVud2VidG9ycmVudC5jb20=',
        'd3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg==',
        'd3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl',
        'd3NzOi8vdHJhY2tlci5idG9ycmVudC54eXov',
        'aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'
      ].map(btoa)
    }
  )
  console.log('torrent', torrent)
  torrent.on('done', () => {
    console.log('done')
    torrentFile.modify((doc) => {
      doc.status = torrent.paused ? 'finished' : 'seeding'
      return doc
    })
  })
  torrent.on('download', () => {
    console.log('download')
    torrentFile.modify((doc) => {
      doc.progress = torrent.progress
      return doc
    })
  })
  torrent.on('error', (err) => {
    console.error(err)
  })
  torrent.on('infoHash', () => {
    console.log('infoHash')
    torrentFile.modify((doc) => {
      doc.infoHash = torrent.infoHash
      return doc
    })
  })
  torrent.on('metadata', () => {
    console.log('metadata')
    torrentFile.modify((doc) => {
      doc.name = torrent.name
      return doc
    })
  })
  torrent.on('ready', () => {
    console.log('ready')
    torrentFile.modify((doc) => {
      doc.status =
        torrent.done ? 'finished' :
        torrent.paused ? 'paused' :
        'downloading'
      return doc
    })
  })
  torrent.on('warning', (err) => {
    console.warn(err)
  })
  torrent.on('wire', (wire) => {
    console.log('wire', wire)
  })
  torrent.on('download', () => {
    console.log('download', torrent.progress)
  })
  torrent.on('upload', () => {
    console.log('upload', torrent.progress)
  })
  torrent.on('noPeers', (announceType) => {
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
