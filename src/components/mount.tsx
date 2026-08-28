import { css } from '@emotion/react'
import { useEffect } from 'react'

import Router from '../router'
import { destroyTorrentClient } from '../torrent/client'
import { hasWebLocks } from '../torrent/engine-protocol'
import { useActiveWindow } from '../utils/active-window-effect'
import { useShellUpdate } from '../torrent/use-shell-update'

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
  border: 1px solid #3a3447;
  border-radius: 8px;
  background: #17141d;
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 0.85rem;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);

  button {
    flex: none;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #f97316;
    background: #f97316;
    color: #1a1020;
    cursor: pointer;

    &:hover { background: #fb8a3c; }
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
