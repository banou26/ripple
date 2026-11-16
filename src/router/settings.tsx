import { css } from '@emotion/react'
import { ArrowLeft, MonitorDown } from 'lucide-react'
import { useState } from 'react'
import { useIntl } from 'react-intl'
import { Link } from 'react-router-dom'

import { hint } from '../components/hint'
import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, FOCUS_RING, PAGE_BG, SURFACE_BG, TEXT, TEXT_MUTED,
} from '../theme'
import { setupHandlers } from '../utils/pwa'
import { getRoutePath, Route } from './path'

const style = css`
  min-height: calc(100dvh - var(--fkn-inset-top, 0px));
  background: ${PAGE_BG};
  color: ${TEXT};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    background: ${SURFACE_BG};
    border-bottom: 1px solid ${BORDER};
  }

  h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 800;
  }

  .back, main button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;

    svg { flex: none; width: 15px; height: 15px; }

    &:hover { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }
  }

  .back {
    width: 38px;
    height: 38px;

    svg { width: 17px; height: 17px; }
  }

  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  main button { padding: 8px 16px; }

  p {
    margin: 0;
    font-size: 0.85rem;
    color: ${TEXT_MUTED};
  }
`

/** What the library's header no longer carries. */
const Settings = () => {
  const intl = useIntl()
  const [said, setSaid] = useState<string | null>(null)
  const library = intl.formatMessage({ id: 'Library', defaultMessage: 'Library' })
  const setupLabel = intl.formatMessage({ id: 'Open torrents with Ripple', defaultMessage: 'Open torrents with Ripple' })
  const onSetupHandlers = async () => {
    const outcome = await setupHandlers()
    if (outcome === 'installed') setSaid(intl.formatMessage({ id: 'Ripple installed', defaultMessage: 'Ripple installed' }))
    else if (outcome === 'magnet-registered') setSaid(intl.formatMessage({ id: 'Confirm the prompt to route magnet links to Ripple.', defaultMessage: 'Confirm the prompt to route magnet links to Ripple.' }))
    else if (outcome === 'already-installed') setSaid(intl.formatMessage({ id: 'Ripple is already installed', defaultMessage: 'Ripple is already installed' }))
    else setSaid(intl.formatMessage({ id: 'Use your browser menu to install Ripple as an app.', defaultMessage: 'Use your browser menu to install Ripple as an app.' }))
  }
  return (
    <div css={style}>
      <header>
        <Link className="back" to={getRoutePath(Route.HOME)} aria-label={library} {...hint(library)}><ArrowLeft aria-hidden="true"/></Link>
        <h1>{intl.formatMessage({ id: 'Settings', defaultMessage: 'Settings' })}</h1>
      </header>
      <main>
        <button type="button" onClick={() => { void onSetupHandlers() }}>
          <MonitorDown aria-hidden="true"/>
          {setupLabel}
        </button>
        {said && <p role="status">{said}</p>}
      </main>
    </div>
  )
}

export default Settings
