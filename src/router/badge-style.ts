import { css, keyframes } from '@emotion/react'

import { BORDER, CONTROL_BG, DANGER, OK, TEXT, TEXT_MUTED } from '../theme'

/**
 * The state chip, in one place, because two views now draw it.
 *
 * The animation is built with emotion's `keyframes` rather than a raw `@keyframes pulse` block. That
 * is not tidiness: a bare name has to be DECLARED in whichever stylesheet is mounted, so a component
 * carrying only the `animation` line animates when home happens to be on screen and silently does
 * not when it is mounted alone. `keyframes` mangles the name and ships the declaration with the
 * rules, so this block is self-contained and a test of the table by itself gets the real behaviour.
 *
 * Interpolated into a parent selector by both callers, so it never needs a wrapper element.
 */
const pulse = keyframes`
  0%, 100% { opacity: 0.7; }
  50% { opacity: 0.25; }
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
    /**
     * One chip, eight states, and the words do the telling.
     *
     * Every state used to have a hue of its own: amber downloading, teal seeding, blue checking,
     * purple done. The badge prints the state in words either way, so the colour was saying
     * nothing the label was not, and the giveaway is that STARTING and MISSING were already the
     * same grey and nobody ever noticed. What is left is brightness for "is this doing something",
     * the pulse on the dot for "and it is still going", and a hue on exactly the two states that
     * are outcomes rather than progress.
     */
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER};
    color: ${TEXT_MUTED};

    &::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.7;
    }

    &.downloading {
      color: ${TEXT};

      &::before {
        animation: ${pulse} 1.6s ease-in-out infinite;
      }
    }
    &.seeding { color: ${TEXT}; }

    /* Working, not waiting: the progress bar tracks the check while this runs. */
    &.checking {
      color: ${TEXT};

      &::before {
        animation: ${pulse} 1.6s ease-in-out infinite;
      }
    }

    /* Connecting rather than idle, so it pulses like the other in-progress states. Quiet, because
       it says nothing yet about whether this torrent is downloading, seeding or finished. */
    &.starting {
      color: ${TEXT_MUTED};

      &::before {
        animation: ${pulse} 1.6s ease-in-out infinite;
      }
    }

    /* the two outcomes, and the only badges that still spend a hue */
    &.done { color: ${OK}; }
    &.error { color: ${DANGER}; }

    /* stated rather than inherited from the base: this state is deliberately the quiet one */
    &.missing { color: ${TEXT_MUTED}; }

    &.retrying {
      color: ${TEXT};

      &::before {
        animation: ${pulse} 1.6s ease-in-out infinite;
      }
    }
  }
`
