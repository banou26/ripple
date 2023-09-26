import type { Collection as TorrentCollection } from '../torrent/collection'

import { css } from '@emotion/react'
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
      div {
        width: 100%;
        height: 8rem;
        padding: 2rem;
        border-bottom: 1px solid #fff;
        background-color: #2f2f2f;

        &:nth-of-type(-n+2) {
          border-top: 1px solid #fff;
        }

        :last-child {
          border-bottom: none;
        }
      }
    }
  }
`


export const TorrentList = ({ ...rest }) => {
  const collection = useRxCollection<TorrentCollection>('torrents')
  const downloadingTorrentQuery = collection?.find({ selector: { status: 'downloading' } }).sort({ addedAt: 'asc' })
  const { result: downloadingTorrents } = useRxQuery(downloadingTorrentQuery)
  const completedTorrentQuery = collection?.find({ selector: { status: 'finished', $or: [{ status: 'seeding' }] } }).sort({ addedAt: 'asc' })
  const { result: completedTorrents } = useRxQuery(completedTorrentQuery)
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
              <div key={torrent.infoHash}>
                {torrent.name} | {torrent.peers}
              </div>
            ))
          }
        </div>
      </div>
      <div className="category">
        <div className="title">Completed</div>
        <div className="items">
          {
            completedTorrents?.map(torrent => (
              <div key={torrent.infoHash}>
                {torrent.name} | {torrent.peers}
              </div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

export default TorrentList
