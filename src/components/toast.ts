import { css } from '@emotion/react'

import { BORDER_STRONG, ELEVATED_BG } from '../theme'
import { MODAL_Z_INDEX } from './modal'

/** A line that floats above the page for a moment, saying how something went. */
export const toastStyle = css`
  position: fixed;
  pointer-events: none;
  bottom: 52px;
  left: 50%;
  transform: translateX(-50%);
  /* opaque, because rows of the live list would slide past under its text; the border says it floats */
  background: ${ELEVATED_BG};
  border: 1px solid ${BORDER_STRONG};
  border-radius: 8px;
  padding: 11px 20px;
  font-size: 0.85rem;
  z-index: ${MODAL_Z_INDEX};
  animation: slide-up 200ms ease-out;

  @keyframes slide-up {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(14px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
`
