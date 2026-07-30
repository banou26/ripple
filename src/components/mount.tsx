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

// Without Web Locks there is nothing to arbitrate the engine with, so the old rule stands:
// exactly one tab may run, and the rest offer to take over. A libtorrent session holds an
// exclusive OPFS lock on every file it writes, so a second one running over the same library
// corrupts both.
const SingleTabMount = () => {
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

// Web Locks decides which tab hosts the engine and the rest borrow it, so every tab is a
// usable one and there is nothing to prompt about.
const Mount = () => (hasWebLocks() ? <Router/> : <SingleTabMount/>)

export default Mount
