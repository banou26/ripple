import { css } from '@emotion/react'
import { createPortal } from 'react-dom'

import { PAGE_BG, TEXT } from '../theme'
import { MODAL_Z_INDEX } from './modal'

const style = css`
  position: fixed;
  inset: 0;
  z-index: ${MODAL_Z_INDEX};
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${PAGE_BG};
  color: ${TEXT};
  font-size: 1.1rem;
  font-weight: 600;
`

/** The whole page while Ripple reloads onto a new build. On body, so it also covers an open modal. */
const Updating = () => createPortal(<div css={style} role="status">Updating Ripple</div>, document.body)

export default Updating
