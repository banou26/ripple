import { HTMLAttributes, ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { css } from '@emotion/react'
import { X } from 'react-feather'

export const modalRootStyle = (height: number) => css`
position: fixed;
inset: 0;
display: flex;
justify-content: center;
z-index: 1300;
overflow-y: auto;
.backdrop {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1040;
  width: 100%;
  height: 100%;
  background-color: #000;
  opacity: 0.5;
}

.modal {
  position: absolute;
  top: 0;
  min-width: 42.5rem;
  z-index: 1060;
  @media (min-height: ${height}px) {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  border: 2px solid #000;
  border-radius: 4px;
  @media (max-width: 425px) {
    min-width: initial;
    width: 100%;
  }
  background-color: #1f1f1f;
  background-clip: padding-box;
  border: none;
  border-radius: .5rem;

  & > .header {
    display: flex;
    padding: 1.6rem;
    border-bottom: .1rem solid rgba(255, 255, 255, 0.1);
    gap: 1rem;
    img {
      height: 2.4rem;
    }
  }

  & > .close {
    cursor: pointer;
    position: absolute;
    top: 2rem;
    right: 1.6rem;
    background: none;
    border: none;
    color: #fff;
    display: grid;
    justify-content: center;
    align-items: center;

    &:hover {
      color: gray;
    }
  }
}
`

export const modalStyle = css`
position: relative;
max-width: 42.5rem;
color: #D1D1D1;

@media (min-width: 640px) {
  display: grid;
}

.header {
  padding: 1.6rem;
  border-bottom: .1rem solid rgba(255, 255, 255, 0.1);

  img {
    height: 2.2rem;
    width: 2.2rem;
    object-fit: cover;
  }

  .title {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 0.4rem;
    width: 100%;
    line-height: 2.3rem;
    font-size: 1.8rem;
    color: #fff;
    font-weight: 500;
    
    &__asset {
      display: flex;
      gap: 0.2rem;
    }
  }
}
`

type ModalRootOptions =
  HTMLAttributes<HTMLDivElement>
  & {
    header?: ReactNode
    children: ReactNode
    onClose: () => any
    preventBackdropClose?: boolean
  }

const ModalRoot = ({ header, onClose, preventBackdropClose, children, ...rest }: ModalRootOptions) => {
  const [ref, setRef] = useState<HTMLDivElement | null>()
  const [height, setHeight] = useState(960)

  useEffect(() => {
    if (!ref) return
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries && entries.length > 0) {
        const { height } = entries[0].contentRect
        setHeight(height)
      }
    })
    resizeObserver.observe(ref)
    return () => resizeObserver.disconnect()
  }, [ref])

  const handleBackdropClose = () => {
    if (preventBackdropClose) return
    onClose()
  }

  return (
    <div css={modalRootStyle(height)} {...rest}>
      <div className="backdrop" onClick={handleBackdropClose}></div>
      <div className="modal" role="dialog" tabIndex={-1} ref={setRef}>
        {
          header !== undefined
            ? <div className="header">{header}</div>
            : header
        }
        {children}
        <button onClick={onClose} className="close">
          <X width={16} height={16} />
        </button>
      </div>
    </div>
  )
}

export type ModalOptions =
  ModalRootOptions
  & {
    open: boolean
  }

export const Modal = ({ open, children, ...rest }: ModalOptions) => {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = document.body.appendChild(document.createElement('div'))
    setRoot(root)
    return () => {
      setTimeout(() => {
        root.remove()
      }, 0)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!root) return null

  return (
    createPortal(
      open
        ? (
          <ModalRoot {...rest}>
            {children}
          </ModalRoot>
        )
        : null,
      root
    )
  )
}

export default Modal
