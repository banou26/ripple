import { css } from '@emotion/react'

import Header from '../../components/header'
import TorrentList from '../../components/torrent-list'

const style = css`
--header-height: 20rem;
.header {
  height: var(--header-height);
  background-color: #0f0f0f;
  padding: 2rem;
}

.torrent-list {
  height: calc(100vh - var(--header-height));
  background-color: #1f1f1f;
}
`



export const Home = () => {
  return (
    <div css={style}>
      <Header className="header"/>
      <TorrentList className="torrent-list"/>
    </div>
  )
}

export default Home
