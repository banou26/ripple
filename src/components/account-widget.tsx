import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ExternalLink, LogOut } from 'react-feather'
import { ConnectButton } from '@fkn/lib/react'

import { MenuSurface } from './menu'
import { useAccount } from '../torrent/use-account'
import {
  BORDER,
  BORDER_STRONG,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  FOCUS_RING,
  OK,
  TEXT,
  TEXT_MUTED,
} from '../theme'

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
  border: 1px solid ${BORDER};
  background: ${CONTROL_BG};
  color: ${TEXT};
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

  /* Premium is a status and keeps its green. Free is not a status, it is the absence of one, so it
     gets the muted text tier rather than a colour of its own. Muted, never faint: nothing below
     TEXT_MUTED clears AA on a control fill, and this label sits on one. */
  .tier.premium { color: ${OK}; }
  .tier.free { color: ${TEXT_MUTED}; }

  .chevron {
    flex: none;
    width: 15px;
    height: 15px;
    color: ${TEXT_MUTED};
    transition: transform 120ms ease;
  }

  /* open reads as pressed, and the aria attribute is what says so rather than a second class */
  &:hover,
  &[aria-expanded='true'] {
    background: ${CONTROL_HOVER_BG};
    border-color: ${BORDER_STRONG};
  }

  &[aria-expanded='true'] .chevron { transform: rotate(180deg); }

  /* An OUTER ring, where a menu row takes an inset one: this button belongs to the header row with
     Share a torrent, not to the list it opens. That split used to be carried by hue as well, orange
     out here against amber in the menu, and monochrome leaves the geometry to say it alone.
     outline: none above means this box-shadow is the only focus indicator the tag has. */
  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px ${FOCUS_RING};
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
  color: ${TEXT};
  font-family: inherit;
  font-size: 0.82rem;
  text-align: left;
  text-decoration: none;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: ${CONTROL_HOVER_BG};
    outline: none;
  }

  /* Inset, and load bearing twice over: outline: none sits right above, and hover and focus share
     the fill on the rule above, so this ring is the only thing telling a keyboard user apart from
     a mouse. */
  &:focus-visible { box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }

  svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: ${TEXT_MUTED};
  }
`

export const AccountWidget = ({ onToast }: { onToast: (message: string) => void }) => {
  const { info, ready, logout } = useAccount()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * WHEN a disconnect was started here, so the next `info` going null can be recognised as ours.
   *
   * A timestamp rather than a flag, because a flag has no way to expire. `logout()` can fail to
   * take without saying so, either by hanging past the cap below or by rejecting into the swallow
   * in use-account.ts, and in both cases the session survives and no null ever arrives to clear it.
   * The flag would then sit armed for the life of the page and hand its credit to some later,
   * unrelated null: a "Disconnected" toast for a broker hiccup, with the account tag still on
   * screen. Measured, not imagined.
   */
  const disconnectingSince = useRef(0)

  const close = useCallback(() => setOpen(false), [])

  /**
   * The menu belongs to a signed-in account and cannot outlive one.
   *
   * This covers every path the click handler never sees: the thirty second poll, a logout in
   * another tab, and the hook's own four second `info()` race resolving null for a merely slow
   * broker. Left set, `open` survives the swap to the ConnectButton and the menu is already showing
   * when an account reconnects.
   *
   * The toast is gated on the window above, so a logout somewhere else cannot claim credit here and
   * a timed-out read cannot announce a disconnect that did not happen.
   */
  useEffect(() => {
    if (info) return
    setOpen(false)
    setBusy(false)
    if (disconnectingSince.current && Date.now() - disconnectingSince.current <= LOGOUT_TIMEOUT) {
      disconnectingSince.current = 0
      onToast('Disconnected')
    }
  }, [info, onToast])

  const onDisconnect = async () => {
    disconnectingSince.current = Date.now()
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
      {/* To the body, not into the header. `place()` measures the trigger with
          getBoundingClientRect and clamps against window.innerWidth, so the numbers it returns are
          viewport coordinates, and MenuSurface writes them straight onto a `position: fixed` box.
          That only lands where it was told while the containing block IS the viewport: an ancestor
          that takes a transform, a filter or containment becomes the containing block instead, and
          the menu then resolves against the header's box with nothing in the arithmetic to notice.
          Out here no ancestor can do that to it. Same reason and same answer as modal.tsx. */}
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
