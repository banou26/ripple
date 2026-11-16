import type { SaveLocation } from '../torrent/library'

import { css } from '@emotion/react'
import { ArrowLeft, MonitorDown } from 'lucide-react'
import { useState } from 'react'
import { useIntl } from 'react-intl'
import { Link } from 'react-router-dom'

import { hint } from '../components/hint'
import { LanguageSelect } from '../components/language-select'
import { PersistControl } from '../components/persist-control'
import { ADD_DIALOG_KEY, dialogEnabled } from '../torrent/add-options'
import { readGlobalDefault, SAVE_LOCATION_KEY } from '../torrent/save-location'
import { useFolder } from '../torrent/use-folder'
import { usePersistentStorage } from '../torrent/use-persistent-storage'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG, FOCUS_RING, PAGE_BG,
  SURFACE_BG, TEXT, TEXT_MUTED,
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

  .back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};

    svg { width: 17px; height: 17px; }
  }

  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 8px 18px 24px;
    display: flex;
    flex-direction: column;
  }

  /* One setting a row, its name then its controls, the way the footer drew them: PersistControl draws its own. */
  .folder {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    padding: 14px 0;
    border-bottom: 1px solid ${BORDER};

    > span {
      flex: 0 0 9rem;
      font-size: 0.85rem;
      font-weight: 700;
      color: ${TEXT_MUTED};
    }
  }

  .folder button, .folder select, .install {
    font: inherit;
    font-size: 0.85rem;
    padding: 7px 14px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${CONTROL_HOVER_BG};
      border-color: ${BORDER_STRONG};
    }

    &:disabled {
      opacity: 0.55;
      cursor: default;
    }

    /* a toggle that is on, or a folder that is live, as the footer drew it */
    &.on {
      background: ${CONTROL_ACTIVE_BG};
      border-color: ${BORDER_INTERACTIVE};
    }
  }

  .back, .folder button, .folder select, .install {
    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px ${FOCUS_RING};
    }
  }

  .install {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 18px;
    font-weight: 700;

    svg { flex: none; width: 15px; height: 15px; }
  }

  p {
    margin: 10px 0 0;
    font-size: 0.85rem;
    color: ${TEXT_MUTED};
  }

  @media (max-width: 700px) {
    header { padding: 8px; }

    main { padding: 4px 12px 24px; }

    .folder > span { flex-basis: 100%; }
  }
`

/** The library's settings and Open torrents with Ripple. Each writes where the library reads it when it opens again. */
const Settings = () => {
  const intl = useIntl()
  const [said, setSaid] = useState<string | null>(null)
  const persistence = usePersistentStorage()
  const { supported: folderSupported, folder, permitted, pick: pickFolder, allow: allowFolder, clear: clearFolder } = useFolder()
  const [addDialog, setAddDialog] = useState(() => dialogEnabled((k) => localStorage.getItem(k)))
  const [defaultLocation, setDefaultLocation] = useState<SaveLocation>(() => {
    try { return readGlobalDefault((k) => localStorage.getItem(k)) } catch { return 'browser' }
  })
  const chooseAddDialog = (on: boolean) => {
    setAddDialog(on)
    try { localStorage.setItem(ADD_DIALOG_KEY, on ? '1' : '0') } catch {}
  }
  const chooseDefaultLocation = (location: SaveLocation) => {
    setDefaultLocation(location)
    try { localStorage.setItem(SAVE_LOCATION_KEY, location) } catch {}
  }

  const library = intl.formatMessage({ id: 'Library', defaultMessage: 'Library' })
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
        <label className="folder">
          <span>{intl.formatMessage({ id: 'Language', defaultMessage: 'Language' })}</span>
          <LanguageSelect/>
        </label>
        <div className="folder">
          <span>{intl.formatMessage({ id: 'On add', defaultMessage: 'On add' })}</span>
          <button type="button" className={addDialog ? 'on' : undefined} onClick={() => chooseAddDialog(!addDialog)}>
            {addDialog
              ? intl.formatMessage({ id: 'Ask what to download', defaultMessage: 'Ask what to download' })
              : intl.formatMessage({ id: 'Start straight away', defaultMessage: 'Start straight away' })}
          </button>
        </div>
        <PersistControl persist={persistence} onAsk={() => void persistence.request()}/>
        {folderSupported && (
          <div className="folder">
            <span>{intl.formatMessage({ id: 'Auto-save', defaultMessage: 'Auto-save' })}</span>
            {!folder
              ? <button type="button" onClick={() => { void pickFolder() }}>{intl.formatMessage({ id: 'Choose folder', defaultMessage: 'Choose folder' })}</button>
              : permitted
                ? (
                  <>
                    <button type="button" className="on" onClick={() => { void pickFolder() }}>{folder.name}</button>
                    <button type="button" onClick={() => { void clearFolder() }}>{intl.formatMessage({ id: 'Stop', defaultMessage: 'Stop' })}</button>
                  </>
                )
                : <button type="button" className="on" onClick={() => { void allowFolder() }}>{intl.formatMessage({ id: 'Allow {name}', defaultMessage: 'Allow {name}' }, { name: folder.name })}</button>}
            {folder && permitted && (
              <button
                type="button"
                className={defaultLocation === 'folder' ? 'on' : undefined}
                onClick={() => chooseDefaultLocation(defaultLocation === 'folder' ? 'browser' : 'folder')}
              >
                {defaultLocation === 'folder'
                  ? intl.formatMessage({ id: 'Files go to {name}', defaultMessage: 'Files go to {name}' }, { name: folder.name })
                  : intl.formatMessage({ id: 'Files stay in the browser', defaultMessage: 'Files stay in the browser' })}
              </button>
            )}
          </div>
        )}
        <button type="button" className="install" onClick={() => { void onSetupHandlers() }}>
          <MonitorDown aria-hidden="true"/>
          {intl.formatMessage({ id: 'Open torrents with Ripple', defaultMessage: 'Open torrents with Ripple' })}
        </button>
        {said && <p role="status">{said}</p>}
      </main>
    </div>
  )
}

export default Settings
