import { css } from '@emotion/react'

import Router from '../router'
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
  // Single-tab guard only - the torrent engine now lives in the libtorrent-wasm
  // worker (per-route), so there's no app-wide client to create/tear down here.
  const { isActive, activate } = useActiveWindow({})

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

  return <Router/>
}


export default Mount
