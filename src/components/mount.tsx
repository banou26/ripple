import { css } from '@emotion/react'
import { useEffect } from 'react'

import Router from '../router'
import { destroyTorrentClient } from '../torrent/client'
import { hasWebLocks } from '../torrent/engine-protocol'
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

// Without Web Locks only one tab may run: a libtorrent session holds an exclusive OPFS lock on every file it writes, and only terminating the worker releases them
const SingleTabMount = () => {
  const { claim, activate } = useActiveWindow({})

  useEffect(() => { if (claim === 'inactive') destroyTorrentClient() }, [claim])

  if (claim === 'probing') return null

  if (claim === 'inactive') {
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

const Mount = () => (hasWebLocks() ? <Router/> : <SingleTabMount/>)

export default Mount
