import type { OpenPage } from './host'

import { css } from '@emotion/react'
import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import { Modal } from '../components/modal'
import { BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, FOCUS_RING, SURFACE_BG, TEXT, TEXT_MUTED } from '../theme'
import { closePage, mountPluginPage } from './host'

/** The sandbox tokens every plugin popup page gets: scripts, own origin, forms and popups; no top navigation. */
export const PAGE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'

const cardStyle = css`
  flex: none;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: ${SURFACE_BG};
  border: 1px solid ${BORDER_STRONG};
  border-radius: 8px;
  color: ${TEXT};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  @media (width >= 600px) {
    &[data-size='small'] {
      width: min(480px, calc(100vw - 32px));
      height: min(360px, calc(100dvh - 48px));
    }

    &[data-size='medium'] {
      width: min(760px, calc(100vw - 32px));
      height: min(560px, calc(100dvh - 48px));
    }

    &[data-size='large'] {
      width: min(1100px, calc(100vw - 32px));
      height: min(800px, calc(100dvh - 48px));
    }

    &[data-inline] {
      max-width: calc(100% - 32px);
      max-height: calc(100% - 48px);
    }
  }

  @media (width < 600px) {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100dvh;
    max-width: none;
    max-height: none;
    border: 0;
    border-radius: 0;

    &[data-inline] {
      position: absolute;
      height: 100%;
    }
  }

  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid ${BORDER};

    h2 {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 0.95rem;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .close {
      flex: none;
      border: 1px solid ${BORDER};
      border-radius: 4px;
      background: ${CONTROL_BG};
      color: ${TEXT_MUTED};
      padding: 4px 12px;
      font: inherit;
      font-size: 0.78rem;
      cursor: pointer;

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: ${BORDER_STRONG};
        color: ${TEXT};
      }

      &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px ${FOCUS_RING};
      }
    }
  }

  iframe {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    display: block;
    background: transparent;
  }

  .status {
    margin: 24px 16px;
    color: ${TEXT_MUTED};
    font-size: 0.9rem;
  }

  /* keeps Tab leaving the cross-origin iframe inside the modal rather than reaching FKN's frame or the browser bar */
  .focus-guard {
    position: fixed;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }
`

/**
 * A plugin's own page, mounted through `packages.mount` into a sandboxed iframe inside Ripple's Modal so Ripple's own
 * dialogs (such as `suggest`'s add dialog) can stack above it and FKN's prompts stay above both.
 */
export const PluginPage = ({ page, inline }: { page: OpenPage, inline?: boolean }) => {
  const intl = useIntl()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const iframe = frameRef.current
    if (!iframe) return
    const abort = new AbortController()
    let unmount = () => {}
    void mountPluginPage(page, iframe, abort.signal)
      .then((mounted) => {
        if (abort.signal.aborted) mounted.unmount()
        else unmount = mounted.unmount
      })
      .catch(() => {
        if (abort.signal.aborted) return
        setFailed(true)
        closeRef.current?.focus()
      })
    return () => {
      abort.abort()
      unmount()
    }
  }, [page])

  return (
    <Modal labelledBy="plugin-page-title" onClose={() => closePage()} initialFocus={frameRef} inline={inline}>
      <div css={cardStyle} className="plugin-page" data-size={page.size} data-inline={inline || undefined}>
        <span
          tabIndex={0}
          data-focus-guard=""
          className="focus-guard"
          aria-hidden="true"
          onFocus={() => (failed ? closeRef : frameRef).current?.focus()}
        />
        <header>
          <h2 id="plugin-page-title" dir="auto">{page.name}</h2>
          <button type="button" className="close" ref={closeRef} onClick={() => closePage()}>
            {intl.formatMessage({ id: 'Close', defaultMessage: 'Close' })}
          </button>
        </header>
        {failed
          ? <p role="alert" className="status">{intl.formatMessage({ id: 'Not responding', defaultMessage: 'Not responding' })}</p>
          : <iframe ref={frameRef} title={page.name} sandbox={PAGE_SANDBOX}/>}
        <span
          tabIndex={0}
          data-focus-guard=""
          className="focus-guard"
          aria-hidden="true"
          onFocus={() => closeRef.current?.focus()}
        />
      </div>
    </Modal>
  )
}
