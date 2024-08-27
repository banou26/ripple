import type WebTorrentType from 'webtorrent'
import _WebTorrent from 'webtorrent/dist/webtorrent.min.js'

const WebTorrent = _WebTorrent as typeof WebTorrentType

export const client =
  new WebTorrent({
    utp: false,
    downloadLimit: 25_000_000
  })
