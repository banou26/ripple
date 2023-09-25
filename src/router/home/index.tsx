import { css } from '@emotion/react'
import StatisticsHeader from '../../components/statistics-header'
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
  // delete all IDB instances
  const resetIdb = () => {
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
    indexedDB.deleteDatabase('rxdb-dexie-ripple--0--torrents')
  }

  const resetOPFS = async () => {
    const directory = await navigator.storage.getDirectory()
    console.log('directory', directory)
    const iterator = directory.entries()
    const nextEntry = async () => {
      const { done, value } = await iterator.next()
      if (!value) return
      const [filePath, handle] = value
      await (handle as FileSystemDirectoryHandle).removeEntry(filePath, { recursive: true })
      if (done) return
      nextEntry()
    }
    nextEntry()
  }

  return (
    <div css={style}>
      <StatisticsHeader className="header"/>
      <button onClick={resetIdb}>reset IDB</button>
      <button onClick={resetOPFS}>reset OPFS</button>
      <TorrentList className="torrent-list"/>
    </div>
  )
}
export default Home
