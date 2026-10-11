import { css } from '@emotion/react'

import type { Reachability } from '../torrent/client'
import { vpnStatus } from '../torrent/vpn-status'
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
      </div>
    </div>
  )
}
