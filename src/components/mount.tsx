import { css } from '@emotion/react'
import { useEffect } from 'react'

import Router from '../router'
import { destroyTorrentClient } from '../torrent/client'
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
  // Single-tab guard. The engine itself is a document-wide singleton created on demand by
  // the routes, so all this has to do is hand it back when another tab takes over.
  const { claim, activate } = useActiveWindow({})

  // Terminating the worker is what releases its exclusive OPFS locks, so the tab that
  // just claimed the library can actually open the files.
  useEffect(() => { if (claim === 'inactive') destroyTorrentClient() }, [claim])

  // Nothing during the probe: the answer arrives within a frame or two, and painting the
  // takeover prompt first made "it will stop the other tab" the app's opening statement
  // on every single load.
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


export default Mount
