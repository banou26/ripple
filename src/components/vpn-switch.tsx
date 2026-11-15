import { useEffect, useId, useRef, useState } from 'react'
import { css } from '@emotion/react'
import { useIntl } from 'react-intl'

import type { Reachability } from '../torrent/client'
import type { QuotaStatus } from '../torrent/use-quota'
import type { EngineTransport } from '../torrent/vpn-config'
import type { VpnStatus } from '../torrent/vpn-status'

import { setVpn } from '../torrent/client'
import { COUNTRY_LINE, inListedCountry } from '../torrent/country-line'
import {
  answerQuotaOffer, onVpnStored, quotaDay, quotaOfferAnswered, rememberVpnWarning, vpnOffAvailable, vpnOn, vpnWarningRemembered,
} from '../torrent/vpn-setting'
import { vpnLabels, vpnStatus } from '../torrent/vpn-status'
import { BORDER_INTERACTIVE, EMPHASIS, FOCUS_RING, HOVER_WASH, OK, SUNKEN_BG, TEXT, TEXT_MUTED, TEXT_ON_LIGHT, WARN } from '../theme'
import { confirmStyle } from './confirm-dialog'
import { hint } from './hint'
import { Modal } from './modal'
import { QuotaOffer } from './quota-offer'

export type VpnSwitching = {
  /** False where the VPN cannot be switched off: its state is all there is to draw. */
  available: boolean
  /**
   * What a switch draws: off the moment that is chosen, on only once the engine is behind the relay, since peers
   * see the address until it is.
   */
  on: boolean
  /** What the engine says of itself, or that it has yet to follow the choice. Null until an engine has said. */
  status: VpnStatus | null
  /** A press of the switch: on at once, off once the warning is answered, or at once where a person asked not to see it again. */
  press: () => void
  /** Answers the warning while it shows, and is null otherwise. */
  answer: ((off: boolean, remember: boolean) => void) | null
  /**
   * Answers the offer to switch the VPN off, made while it is on and the FKN quota is used up, and is null while there
   * is none to make: not before the relay's next day once answered. True presses the switch, warning and all.
   */
  offer: ((off: boolean) => void) | null
}

/**
 * The VPN's switch, for every torrent of this browser storage, as one answer each surface draws its own way: the
 * library and the download page as a labelled switch (`VpnSwitch`), the player as an icon in its top row.
 */
export const useVpnSwitch = (
  reachable: Reachability | null,
  transport: EngineTransport | null | undefined,
  quota: QuotaStatus | null,
): VpnSwitching => {
  const available = vpnOffAvailable()
  const [chosen, setChosen] = useState(vpnOn)
  const [warning, setWarning] = useState(false)
  // the day this page answered the offer, which holds where the browser refuses to store it
  const [answered, setAnswered] = useState<number | null>(null)
  useEffect(() => onVpnStored(() => setChosen(vpnOn())), [])

  const choose = (next: boolean) => {
    void setVpn(next)
    // read back: a browser that refused to store it keeps the choice it had
    setChosen(vpnOn())
  }
  const status = vpnStatus(reachable, transport, available ? chosen : undefined)
  const press = () => {
    if (!chosen) choose(true)
    else if (vpnWarningRemembered()) choose(false)
    else setWarning(true)
  }
  const offered = available && chosen && !warning && !!quota?.throttled && answered !== quotaDay() && !quotaOfferAnswered()

  return {
    available,
    on: chosen && status?.state !== 'waiting',
    status,
    press,
    answer: warning
      ? (off, remember) => {
        setWarning(false)
        if (!off) return
        if (remember) rememberVpnWarning()
        choose(false)
      }
      : null,
    offer: offered
      ? (off) => {
        answerQuotaOffer()
        setAnswered(quotaDay())
        if (off) press()
      }
      : null,
  }
}

/* A player in a phone held upright is some 200px tall: there the card is drawn smaller, its actions side by side. */
const warningStyle = css`
  p + p {
    margin-top: 8px;
  }

  @media (max-height: 320px) {
    .card {
      padding: 8px 12px;
    }

    p {
      font-size: 0.8rem;
      line-height: 1.4;
    }

    p + p {
      margin-top: 6px;
    }

    label {
      margin-top: 8px;
    }

    .actions {
      flex-direction: row;
      margin-top: 10px;

      button {
        width: auto;
        padding: 6px 12px;
      }
    }
  }
`

/**
 * What switching the VPN off asks first. `inline` draws it inside the player, which in fullscreen shows nothing
 * outside itself.
 */
export const VpnWarning = ({ onAnswer, inline }: { onAnswer: (off: boolean, remember: boolean) => void, inline?: boolean }) => {
  const intl = useIntl()
  const [remember, setRemember] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)

  return (
    <Modal labelledBy="vpn-warning" onClose={() => onAnswer(false, false)} initialFocus={cancel} inline={inline}>
      <div css={[confirmStyle, warningStyle]}>
        <div className="card">
          <div id="vpn-warning">
            <p>
              {intl.formatMessage({
                id: 'Peers and trackers of every running torrent will see your IP address.',
                defaultMessage: 'Peers and trackers of every running torrent will see your IP address.',
              })}
            </p>
            {/* asked as the warning is drawn, and kept nowhere */}
            {inListedCountry() && <p>{intl.formatMessage(COUNTRY_LINE)}</p>}
          </div>
          <label>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/>
            {intl.formatMessage({ id: 'Remember this decision', defaultMessage: 'Remember this decision' })}
          </label>
          <div className="actions">
            <button type="button" ref={cancel} onClick={() => onAnswer(false, false)}>
              {intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}
            </button>
            <button type="button" onClick={() => onAnswer(true, remember)}>
              {intl.formatMessage({ id: 'Turn off', defaultMessage: 'Turn off' })}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Gives a word the room of the widest one it can show, so a change of state moves nothing beside it. `data-room`
 * carries every word, one per line, laid under it with no height: the box is as wide as the widest in whatever
 * font and language draw the page, which no width written here could be. For an element drawn as a grid.
 */
export const wordRoom = css`
  &::after {
    content: attr(data-room);
    height: 0;
    overflow: hidden;
    visibility: hidden;
    white-space: pre;
    min-width: max-content;
  }
`

/*
 * Self contained: it is mounted in the library's strip and in the download page's header, which share no rule.
 *
 * Unreachable is WARN rather than DANGER because nothing has failed: the tunnel is simply not up, which is
 * recoverable, and the palette spends DANGER on outcomes rather than states. Every state carries a different
 * WORD as well as a different colour, so the readout still separates without one. Off and Waiting take no colour:
 * somebody chose them.
 */
const style = css`
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;

  .name {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${TEXT_MUTED};
  }

  .value {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  strong {
    display: inline-grid;
    font-size: 1.05rem;
    white-space: nowrap;
    color: ${TEXT};
    ${wordRoom}

    /*
     * Before an engine has said a word the same words keep the line, on one line with no width, so the first
     * word moves nothing under the switch. Written in 1lh it would be the first font's line, and a word drawn
     * in a fallback font, as Japanese is, stands 4px taller.
     */
    &:empty::before {
      content: attr(data-room);
      width: 0;
      overflow: hidden;
      visibility: hidden;
    }
  }

  strong.ok { color: ${OK}; }

  &.error strong { color: ${WARN}; }

  &[role='switch'] {
    /* a 40px target, without the header growing by it */
    margin: -3px -8px;
    padding: 3px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    font: inherit;
    text-align: start;
    cursor: pointer;

    &:hover { background: ${HOVER_WASH}; }

    &:focus-visible {
      outline: 2px solid ${FOCUS_RING};
      outline-offset: 2px;
    }
  }

  /* logical sizes and margins, so the thumb and the word swap sides with the direction of the text */
  .track {
    flex: none;
    box-sizing: border-box;
    inline-size: 28px;
    block-size: 16px;
    padding-inline: 2px;
    display: flex;
    align-items: center;
    border: 1px solid ${BORDER_INTERACTIVE};
    border-radius: 8px;
    background: ${SUNKEN_BG};
    transition: background 120ms ease, border-color 120ms ease;

    &::after {
      content: '';
      inline-size: 10px;
      block-size: 10px;
      border-radius: 50%;
      background: ${TEXT_MUTED};
      transition: margin 120ms ease, background 120ms ease;
    }
  }

  &[aria-checked='true'] .track {
    border-color: ${EMPHASIS};
    background: ${EMPHASIS};

    &::after {
      margin-inline-start: 12px;
      background: ${TEXT_ON_LIGHT};
    }
  }
`

/**
 * The VPN's switch with its state, or its state alone where the VPN cannot be switched off. `quota` is the page's own
 * reading of the FKN quota, null where it has none: the offer to switch off once it is used up hangs under the switch.
 */
export const VpnSwitch = ({ reachable, transport, quota }: {
  reachable: Reachability | null
  transport?: EngineTransport | null
  quota: QuotaStatus | null
}) => {
  const intl = useIntl()
  const vpn = useVpnSwitch(reachable, transport, quota)
  const anchor = useId()
  const { status } = vpn
  // with no switch to draw, nothing known yet is not the same as off, and claiming off would invent a fault out of a gap
  if (!vpn.available && !status) return null

  const fault = status?.state === 'healing' || status?.state === 'unreachable'
  const shared = { css: style, className: 'stat vpn' + (fault ? ' error' : ''), ...hint(status?.detail) }
  const body = (
    <>
      <span className="name">{intl.formatMessage({ id: 'VPN', defaultMessage: 'VPN' })}</span>
      <span className="value">
        {vpn.available && <span className="track"/>}
        <strong className={status?.state === 'on' ? 'ok' : undefined} data-room={vpnLabels().join('\n')}>{status?.label}</strong>
      </span>
    </>
  )

  if (!vpn.available) return <div {...shared}>{body}</div>
  return (
    <>
      <button type="button" role="switch" id={anchor} aria-checked={vpn.on} onClick={vpn.press} {...shared}>{body}</button>
      {vpn.offer && <QuotaOffer anchor={anchor} onAnswer={vpn.offer}/>}
      {vpn.answer && <VpnWarning onAnswer={vpn.answer}/>}
    </>
  )
}
