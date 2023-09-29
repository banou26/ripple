import type { TorrentDocument } from '../torrent/collection'

import { serverProxyFetch } from '@fkn/lib'
import { css } from '@emotion/react'
import { useEffect, useState } from 'react'
import { RxDocument } from 'rxdb'
import { useRxCollection, useRxQuery } from 'rxdb-hooks'

const style = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  width: 100%;

  .category {
    width: 100%;
    height: 100%;

    & > .title {
      font-size: 2rem;
      font-weight: bold;
      width: 100%;
      height: 4rem;
      padding: 1rem;
      border-bottom: 1px solid #fff;
      background-color: #2f2f2f;
    }

    .items {

    }

    .item {
      display: flex;
      width: 100%;
      height: 12rem;
      padding: 2rem;
      border-bottom: 1px solid #fff;
      background-color: #2f2f2f;

      .main {
        display: flex;


        .preview {
          height: 8rem;
          margin-right: 1rem;
        }

        .name {
          font-size: 2rem;
          font-weight: bold;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        button {
          width: 4rem;
          height: 2rem;
          margin-right: 0.5rem;
          border-radius: 0.5rem;
          border: none;
          background-color: #fff;
          cursor: pointer;

          &.active {
            background-color: #2f2f2f;
            color: #fff;
          }
        }
      }

      .info {
        margin-left: auto;
      }



      &:nth-of-type(-n+2) {
        border-top: 1px solid #fff;
      }

      :last-child {
        border-bottom: none;
      }
    }
  }
`

const getDuckDuckGoToken = async (name: string) => {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(name)}&iax=images&ia=images`
  const res = await serverProxyFetch(url, {  }).then(res => res.text())
  const result = res.match(/,vqd="(.*?)"/)
  console.log('result', res.slice(result.index - 10, result.index + result[1].length + 10))
  return result[1]
}

const getFirstGoogleImageResult = async (name: string) => {
  // https://duckduckgo.com/?q=Sintel&iax=images&ia=images
  // const url = `https://duckduckgo.com/?q=${encodeURI(name.replaceAll(' ', '+'))}&iax=images&ia=images`
  const token = await getDuckDuckGoToken(name)
  console.log('token', token)
  const res = await serverProxyFetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(name).replaceAll('-', '%2D')}&vqd=${token}&f=,,,,,&p=1`, {  }).then(res => res.text())
  const dom = new DOMParser().parseFromString(res, 'text/html')
  const results = JSON.parse(dom.body.textContent || '{results:[]}').results
  console.log('results', results)
  // const result = res.match(/_setImgSrc\('i10', '(data:image\\\/.*)'\)/)
  // return result
  return results[0].image
}

const TorrentItem = ({ torrent }: { torrent: RxDocument<TorrentDocument> }) => {
  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    getFirstGoogleImageResult(torrent.name).then(setImgUrl)
  }, [])

  return (
    <div key={torrent.infoHash} className="item">
      <div className="main">
        <div>
          <img className="preview" src={imgUrl} alt="" />
        </div>
        <div>
          <span className="name">{torrent.name}</span>
          <div>
            <button className={torrent.p2p ? 'active' : ''}>P2P</button>
            <button className={torrent.proxy ? 'active' : ''}>Proxy</button>
          </div>
        </div>
      </div>
      <div className="info">
        <div>
          <span>Peers: {torrent.peers.length}</span>
        </div>
        <div>
          <span>Size: {torrent.size}</span>
        </div>
      </div>
    </div>
  )
}

export const TorrentList = ({ ...rest }) => {
  const collection = useRxCollection<TorrentDocument>('torrents')
  const downloadingTorrentQuery = collection?.find({ selector: { status: 'downloading' } }).sort({ addedAt: 'asc' })
  const { result: downloadingTorrents } = useRxQuery(downloadingTorrentQuery)
  const completedTorrentQuery = collection?.find({ selector: { status: { $in: ['finished', 'seeding'] } } }).sort({ addedAt: 'asc' })
  const { result: completedTorrents } = useRxQuery(completedTorrentQuery)
  console.log('downloadingTorrents', downloadingTorrents)
  console.log('completedTorrents', completedTorrents)

  return (
    <div css={style} {...rest}>
      <div className="category">
        <div className="title">Downloading</div>
        <div>
          Drop or Paste files or magnets to start downloading
        </div>
        <div className="items">
          {
            downloadingTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
        </div>
      </div>
      <div className="category">
        <div className="title">Completed</div>
        <div className="items">
          {
            completedTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
        </div>
      </div>
    </div>
  )
}

export default TorrentList
