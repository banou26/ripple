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
  const collection = useRxCollection('torrents')
  const query = collection?.find().sort({ addedAt: 'asc' })
  const { result: torrents } = useRxQuery(query)
  // console.log('torrents', torrents)

  return (
    <div css={style} {...rest}>
      <div className="category">
        <div className="title">Downloading</div>
        <div>
          Drop or Paste files or magnets to start downloading
        </div>
        {/* <div className="items">
          {
            torrents?.map(torrent => (
              <div key={torrent.infoHash}>
                {torrent.name}
              </div>
            ))
          }
        </div> */}
      </div>
      <div className="category">
        <div className="title">Completed</div>
        <div className="items">
          {
            torrents?.map(torrent => (
              <div key={torrent.infoHash}>
                {torrent.name}
              </div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

export default TorrentList
