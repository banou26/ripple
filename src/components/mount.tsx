import { css } from '@emotion/react'

import Router from '../router'
import { createWebtorrent, WebTorrentContext } from '../utils/torrent'
import { useActiveWindow } from '../utils/active-window-effect'

const style = css`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;

  & > div {
    margin: 1rem;
  }
`

const Mount = () => {
  const { isActive, value, activate } = useActiveWindow({
    onActive: () => createWebtorrent(),
    onInactive: (webtorrent) => webtorrent?.destroy()
  })

  if (!isActive) {
    return (
      <div css={style}>
        <div>Only one page can be active at a time.</div>
        <div>Do you want this tab/window to take over? It will stop the other tab/window.</div>
        <div>
          <button onClick={activate}>Yes, take over</button>
        </div>
      </div>
    )
  }

  return (
    <WebTorrentContext.Provider value={value}>
      <Router/>
    </WebTorrentContext.Provider>
  )
}


export default Mount
