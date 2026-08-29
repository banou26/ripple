import { css } from '@emotion/react'
import { useEffect } from 'react'

import Router from '../router'
import { destroyTorrentClient } from '../torrent/client'
import { hasWebLocks } from '../torrent/engine-protocol'
import { useActiveWindow } from '../utils/active-window-effect'
import { useShellUpdate } from '../torrent/use-shell-update'
import { BORDER_STRONG, ELEVATED_BG, EMPHASIS, EMPHASIS_HOVER, TEXT, TEXT_ON_LIGHT } from '../theme'

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

const banner = css`
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  z-index: 2001;
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: calc(100vw - 32px);
  padding: 11px 14px 11px 18px;
  /* This border is now the whole separation between the banner and whatever it is floating over. It
     used to share that job with a 48px drop shadow, so a hairline was enough; alone it is not,
     because ELEVATED_BG is 1.05:1 against the surfaces underneath it and carries no depth by
     itself. Hence BORDER_STRONG, which is what every floating thing in this app takes now. */
  border: 1px solid ${BORDER_STRONG};
  border-radius: 8px;
  background: ${ELEVATED_BG};
  color: ${TEXT};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 0.85rem;

  /* The banner's only action, and it has to keep looking like one. A neutral fill would leave it a
     bright label in a line of bright banner text, so it stays the loudest object here: a light fill
     with the dark label that fill demands. The label was a near-black before too, but only because
     the fill was bright orange; carried onto any neutral fill it would have gone black on black.
     Hover steps the fill down to EMPHASIS_HOVER and keeps the dark label, which is what every
     primary button in the app does: a light fill has nowhere brighter to go, and flipping it to a
     dark fill would make the loudest control on the page read as switching off under the cursor.
     The border follows the fill so the step down stays one flat surface rather than growing a ring. */
  button {
    flex: none;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid ${EMPHASIS};
    background: ${EMPHASIS};
    color: ${TEXT_ON_LIGHT};
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${EMPHASIS_HOVER};
      border-color: ${EMPHASIS_HOVER};
      color: ${TEXT_ON_LIGHT};
    }
  }
`

/**
 * Mounted here rather than in a route, because an update reaches every page and the pages most
 * likely to be mid-transfer are `/embed` and the download page, not the library.
 *
 * z-index 2001 puts it over ripple's context menu (2000) and under the modal shell, so an open
 * dialog still covers it: a person answering a question should not be interrupted by a suggestion.
 */
const ShellUpdateNotice = () => {
  const { pending, reload } = useShellUpdate()
  if (!pending) return null
  return (
    <div css={banner} role="status">
      <span>FKN updated. Reload when your transfers are done.</span>
      <button type="button" onClick={reload}>Reload now</button>
    </div>
  )
}

const Mount = () => (
  <>
    {hasWebLocks() ? <Router/> : <SingleTabMount/>}
    <ShellUpdateNotice/>
  </>
)

export default Mount
