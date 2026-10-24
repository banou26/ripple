import { css } from '@emotion/react'
import { useEffect } from 'react'

import Router from '../router'
import { destroyTorrentClient } from '../torrent/client'
import { hasWebLocks } from '../torrent/engine-protocol'
import { useActiveWindow } from '../utils/active-window-effect'
import { useRippleUpdate } from '../utils/use-ripple-update'
import Updating from './updating'

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
        <div>Ripple is open in another tab.</div>
        <div>
          <button onClick={activate}>Use it here instead</button>
        </div>
      </div>
    )
  }

  return <Router/>
}

/**
 * The update gate lives here rather than in a route, because an update reaches every page and the
 * pages most likely to be open are `/watch` and the download page, not the library.
 */
const Mount = () => {
  const updating = useRippleUpdate()
  return (
    <>
      {hasWebLocks() ? <Router/> : <SingleTabMount/>}
      {updating && <Updating/>}
    </>
  )
}

export default Mount
