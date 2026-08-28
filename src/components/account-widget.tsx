import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ExternalLink, LogOut } from 'react-feather'
import { ConnectButton } from '@fkn/lib/react'

import { MenuSurface } from './menu'
import { useAccount } from '../torrent/use-account'
import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'

/**
 * The account tag in the header, and the menu it opens.
 *
 * It used to be the tag with a Disconnect button permanently beside it, which spends header width
 * on something almost nobody clicks and still offered no way to reach the account itself. It is now
 * a menu button: the tag states who you are, and pressing it offers the two things there are to do.
 */

/**
 * Where the account itself lives.
 *
 * @fkn/lib exports no settings call and no settings URL: its whole account surface is
 * info | login | logout | onChange. fkn.app has no /settings route either, /account IS the settings
 * page, and the quota line in home.tsx already links exactly this. The two must not drift.
 */
const MANAGE_URL = 'https://fkn.app/account'

/**
 * A cap on the busy label, because `logout()` cannot be waited on honestly.
 *
 * It awaits the broker handshake through a promise with no timeout, so a frame that never
 * establishes leaves the await pending forever and the row would read "Disconnecting..." until the
 * page is reloaded. It also cannot report failure, since the one error it raises is swallowed
 * inside @fkn/lib. So the promise is not the answer to "did this work"; `info` going null is, and
 * the effect below is what reads it.
 *
 * Exported so a test can drive the hang without waiting eight real seconds.
 */
export const LOGOUT_TIMEOUT = 8_000

const triggerStyle = css`
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* the ConnectButton's iframe is a hardcoded 140x38 and this replaces it in place, so matching the
     height is what keeps the header from changing height the moment the broker answers */
  min-height: 38px;
  padding: 4px 8px 4px 12px;
  border-radius: 6px;
  border: 1px solid #3a3447;
  background: ${CONTROL_BG};
  color: #f4f2f8;
  font-family: inherit;
  cursor: pointer;

  .who {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    line-height: 1.15;
    min-width: 0;
  }

  .name {
    font-size: 0.82rem;
    font-weight: 600;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tier {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .tier.premium { color: #7dd3a0; }
  .tier.free { color: #8b8499; }

  .chevron {
    flex: none;
    width: 15px;
    height: 15px;
    color: #8b8499;
    transition: transform 120ms ease;
  }

  /* open reads as pressed, and the aria attribute is what says so rather than a second class */
  &:hover,
  &[aria-expanded='true'] {
    background: ${CONTROL_HOVER_BG};
    border-color: rgba(249, 115, 22, 0.45);
  }

  &[aria-expanded='true'] .chevron { transform: rotate(180deg); }

  /* the header family's outer orange ring, not the menu family's inset amber one: this button
     belongs to the row with Share a torrent, not to the list it opens */
  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.55);
  }
`

const rowStyle = css`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 4px;
  background: none;
  color: #f4f2f8;
  font-family: inherit;
  font-size: 0.82rem;
  text-align: left;
  text-decoration: none;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: #2a2338;
    outline: none;
  }

  &:focus-visible { box-shadow: inset 0 0 0 2px #fbbf24; }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }

  svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: #8b8499;
  }
`

export const AccountWidget = ({ onToast }: { onToast: (message: string) => void }) => {
  const { info, ready, logout } = useAccount()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // a disconnect started HERE is in flight, so the next `info` going null is ours to announce
  const disconnecting = useRef(false)

  const close = useCallback(() => setOpen(false), [])

  /**
   * The menu belongs to a signed-in account and cannot outlive one.
   *
   * This covers every path the click handler never sees: the thirty second poll, a logout in
   * another tab, and the hook's own four second `info()` race resolving null for a merely slow
   * broker. Left set, `open` survives the swap to the ConnectButton and the menu is already showing
   * when an account reconnects.
   *
   * The toast is gated on the flag, so a logout somewhere else cannot claim credit here and a
   * timed-out read cannot announce a disconnect that did not happen.
   */
  useEffect(() => {
    if (info) return
    setOpen(false)
    setBusy(false)
    if (disconnecting.current) {
      disconnecting.current = false
      onToast('Disconnected')
    }
  }, [info, onToast])

  const onDisconnect = async () => {
    disconnecting.current = true
    setBusy(true)
    try {
      await Promise.race([logout(), new Promise((resolve) => setTimeout(resolve, LOGOUT_TIMEOUT))])
    } finally {
      // after the call settles, never optimistically: while it is in flight this row is the only
      // place the user is told anything is happening at all
      setBusy(false)
      setOpen(false)
    }
  }

  // every hook is above these returns: the widget has three shapes and only one of them has a menu
  if (!ready) return null
  if (!info) return <ConnectButton style={{ flex: 'none', width: 140, height: 38 }}/>

  const name = info.name || 'Account'
  const tier = info.premium ? 'Premium' : 'Free'

  return (
    <>
      <button
        className="account-tag"
        css={triggerStyle}
        type="button"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        // the tier is in here as well as on screen: an aria-label REPLACES the content, so leaving
        // it out would hide one of the two things this tag exists to say
        aria-label={`FKN account: ${name}, ${tier}`}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="who">
          <span className="name">{name}</span>
          <span className={`tier ${info.premium ? 'premium' : 'free'}`}>{tier}</span>
        </span>
        <ChevronDown className="chevron" aria-hidden="true"/>
      </button>
      {/* To the body, not into the header. The header carries backdrop-filter, which is BOTH a
          stacking context and a containing block for fixed descendants, so a menu left in place
          would resolve its coordinates against the header box while its arithmetic reads
          window.innerWidth, and would still paint under the drop overlay and the toast. Same reason
          and same answer as modal.tsx. */}
      {open && createPortal(
        <MenuSurface placement={{ kind: 'under', of: trigger }} label={`Account: ${name}`} onClose={close}>
          {/* an anchor, not a button calling window.open: it keeps middle-click, ctrl-click, open
              in new tab, and the status bar preview of where it actually goes */}
          <a
            css={rowStyle}
            role="menuitem"
            tabIndex={-1}
            href={MANAGE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={close}
          >
            <ExternalLink aria-hidden="true"/>
            <span className="text">Manage account</span>
          </a>
          {/* "Disconnect" rather than "Log out", which is what it does: this clears the connect
              token for THIS site, and the fkn.app session and every other connected site survive
              it. "Log out" would promise a sign-out that does not happen. */}
          <button
            css={rowStyle}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={busy}
            onClick={() => { void onDisconnect() }}
          >
            <LogOut aria-hidden="true"/>
            <span className="text">{busy ? 'Disconnecting...' : 'Disconnect'}</span>
          </button>
        </MenuSurface>,
        document.body,
      )}
    </>
  )
}
