import type { TorrentState } from '../torrent/types'

import { css, keyframes } from '@emotion/react'

import {
  CONTROL_BG, STATE_DOWN, STATE_ERROR, STATE_MISSING, STATE_MISSING_EDGE, STATE_PAUSED, STATE_QUEUED, STATE_UP,
  TEXT_MUTED, tint,
} from '../theme'

/** Which hue each state takes, in one place, because the cards and the table both draw it. */
export const STATE_HUE: Record<TorrentState, string> = {
  downloading: STATE_DOWN,
  checking: STATE_DOWN,
  seeding: STATE_UP,
  completed: STATE_UP,
  paused: STATE_PAUSED,
  queued: STATE_QUEUED,
  starting: STATE_MISSING,
  error: STATE_ERROR,
  retrying: STATE_ERROR,
  missing: STATE_MISSING,
}

/**
 * Sets `--hue`, `--tint` and `--edge` on anything carrying `data-state`, and on a chip carrying the state as its class,
 * so everything inside a row reads one set of variables. The grey of Files missing and Starting keeps today's neutral
 * chip fill, since grey on a grey tint would fall under AA, and a quieter edge.
 */
export const stateHues = css`
  ${Object.entries(STATE_HUE).map(([state, hue]) => `
    [data-state='${state}'], .badge.${state} {
      --hue: ${hue};
      --tint: ${hue === STATE_MISSING ? CONTROL_BG : tint(hue)};
      --edge: ${hue === STATE_MISSING ? STATE_MISSING_EDGE : hue};
    }
  `).join('')}
`

/**
 * The state chip. The animation is built with emotion's `keyframes` rather than a raw `@keyframes pulse` block: a
 * bare name has to be declared in whichever stylesheet is mounted, so a component carrying only the `animation` line
 * would animate when home happens to be on screen and silently not when mounted alone. Interpolated into a parent
 * selector by both callers, so it never needs a wrapper element.
 */
const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
`

export const badgeRules = css`
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    border-radius: 4px;
    background: var(--tint, ${CONTROL_BG});
    border: 1px solid var(--tint, ${CONTROL_BG});
    color: var(--hue, ${TEXT_MUTED});

    &::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
    }

    /* still going, so the dot breathes */
    &.downloading, &.checking, &.starting, &.retrying {
      &::before {
        animation: ${pulse} 1.6s ease-in-out infinite;
      }
    }
  }
`
