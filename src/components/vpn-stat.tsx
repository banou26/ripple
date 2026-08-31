import { css } from '@emotion/react'
import { Info } from 'react-feather'

import type { Reachability } from '../torrent/client'
import { VPN_EXPLAINER, vpnStatus } from '../torrent/vpn-status'
import { OK, TEXT, TEXT_MUTED, WARN } from '../theme'
import { hint } from './hint'

/**
 * The WebVPN readout, in the shape the library strip and the download page header both use.
 *
 * Self contained on purpose. It started life inside home's stats strip, which styles every `.stat`
 * it contains, and it is now also mounted on the download page where none of those rules exist. So
 * it carries its own appearance and lets the strip's more specific rules win where they overlap:
 * dropped onto a bare page it still looks like itself, which is the whole point of moving it out.
 *
 * The state logic is in `vpn-status`, shared with the player overlay, which draws the same answer as
 * an icon in a row of icons rather than as a labelled figure.
 */
const style = css`
  display: flex;
  flex-direction: column;
  gap: 2px;

  label {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${TEXT_MUTED};
  }

  /* the figure and its explainer on one line, so the glyph sits against the word it explains rather
     than against the label above it */
  .value {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  strong {
    font-size: 1.05rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: ${TEXT};
  }

  strong.ok { color: ${OK}; }

  /*
   * Off is WARN rather than DANGER because nothing has failed: the tunnel is simply not up, which is
   * recoverable, and the palette spends DANGER on outcomes rather than states. Both states carry a
   * different WORD as well as a different colour, so the readout still separates without one.
   */
  &.error strong { color: ${WARN}; }

  /* Dimmer than the figure and it stays dimmer: this is an aside, and a bright glyph beside a status
     word would read as part of the status. It brightens under the cursor, which is the only feedback
     a hover target with no fill can give. */
  .info {
    display: inline-flex;
    color: ${TEXT_MUTED};
    cursor: help;
    transition: color 120ms ease;

    /*
     * flex and min-width are stated, not just the size.
     *
     * home's stats panel used to size its speed graph with a bare "svg" selector, which reached
     * every glyph in the panel including this one, and a width alone loses to its min-width: the
     * 13px icon was laid out in a 120px box and drew itself centred in it. That rule is now scoped
     * to "svg.graph", so this no longer has anything to fight.
     *
     * Kept anyway, because this component is mounted on two pages by design and states its own
     * appearance rather than leaning on either parent. The parent rule was only half the problem;
     * the other half was that emotion inserts rules in RENDER order, so two equally specific rules
     * swap winners depending on which page somebody arrived from. An icon that names its own size
     * cannot be caught by that whichever way round the sheet ends up.
     *
     * No backticks anywhere in this block. It sits inside a css template literal, so one would end
     * the string and the whole module stops parsing.
     */
    svg {
      flex: none;
      min-width: 0;
      width: 13px;
      height: 13px;
    }

    &:hover { color: ${TEXT}; }
  }
`

/** Exported for its own test, like every other stat: a stat that throws takes the whole route with it. */
export const VpnStat = ({ reachable }: { reachable: Reachability | null }) => {
  const status = vpnStatus(reachable)
  // nothing known yet is not the same as off, and claiming off would invent a fault out of a gap
  if (!status) return null
  const on = status.state === 'on'

  return (
    <div css={style} className={'stat vpn' + (on ? '' : ' error')} {...hint(status.detail)}>
      <label>VPN</label>
      <div className="value">
        <strong className={on ? 'ok' : undefined}>{status.label}</strong>
        {/* The glyph carries its OWN title, so it wins over the state title on the wrapper: hovering
            the icon asks what this readout is, hovering anywhere else asks what it currently says.
            Two questions, and the nearest title is the one a browser shows. */}
        <span className="info" {...hint(VPN_EXPLAINER)} aria-label={VPN_EXPLAINER} role="img">
          <Info />
        </span>
      </div>
    </div>
  )
}
