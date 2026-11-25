import type { SaveLocation } from '../torrent/library'

import { css } from '@emotion/react'
import { ArrowLeft, MonitorDown } from 'lucide-react'
import { set } from 'idb-keyval'
import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { Link } from 'react-router-dom'

import { hint } from '../components/hint'
import { LanguageSelect } from '../components/language-select'
import { PersistControl } from '../components/persist-control'
import { PluginsSection } from '../plugins/plugins-section'
import { runningTorrentClient } from '../torrent/client'
import { ADD_DIALOG_KEY, dialogEnabled } from '../torrent/add-options'
import { readGlobalDefault, SAVE_LOCATION_KEY } from '../torrent/save-location'
import {
  DEFAULT_SEED_MINUTES, DEFAULT_SEED_RATIO, MAX_SEED_MINUTES, MAX_SEED_RATIO, MIN_SEED_MINUTES, MIN_SEED_RATIO,
  SEEDING_POLICY_KEY, onSeedingPolicyChange, parseSeedMinutes, parseSeedRatio, readSeedingPolicy, sameSeedingPolicy,
  writeSeedingPolicy,
} from '../torrent/seeding-policy'
import type { SeedingPolicy } from '../torrent/seeding-policy'
import { onSettingApplied, recordSetting } from '../torrent/settings-sync'
import { useFolder } from '../torrent/use-folder'
import { usePersistentStorage } from '../torrent/use-persistent-storage'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG, EMPHASIS, FOCUS_RING,
  PAGE_BG, SUNKEN_BG, SURFACE_BG, TEXT, TEXT_MUTED,
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

  .folder select {
    max-width: 100%;
  }

  .seeding-limits {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1 1 20rem;
    min-width: 0;
    max-width: 100%;
  }

  .seeding-limit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    min-width: 0;
  }

  .seeding-check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: ${TEXT};
    cursor: pointer;
    min-width: 0;
    max-width: 100%;

    input {
      flex: none;
      margin: 0;
      width: 15px;
      height: 15px;
      accent-color: ${EMPHASIS};
    }
  }

  .seeding-value {
    display: inline-flex;
    align-items: center;
    gap: 6px;

    .unit {
      font-size: 0.85rem;
      color: ${TEXT_MUTED};
    }
  }

  .folder input[type='number'] {
    font: inherit;
    font-size: 0.85rem;
    width: 5.5rem;
    padding: 7px 10px;
    border-radius: 6px;
    border: 1px solid ${BORDER_INTERACTIVE};
    background: ${SUNKEN_BG};
    color: ${TEXT};

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }

  .back, .folder button, .folder select, .folder input[type='number'], .seeding-check input, .install {
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
  const [seedingPolicy, setSeedingPolicy] = useState<SeedingPolicy>(() => readSeedingPolicy())
  const [ratioText, setRatioText] = useState(() => String(seedingPolicy.ratio ?? DEFAULT_SEED_RATIO))
  const [minutesText, setMinutesText] = useState(() => String(seedingPolicy.minutes ?? DEFAULT_SEED_MINUTES))
  const skipRatioCommit = useRef(false)
  const skipMinutesCommit = useRef(false)
  useEffect(() => {
    const offSeeding = onSeedingPolicyChange((next) => {
      setSeedingPolicy(next)
      if (next.ratio !== null) setRatioText(String(next.ratio))
      if (next.minutes !== null) setMinutesText(String(next.minutes))
    })
    const offAdd = onSettingApplied('addDialog', setAddDialog)
    const offLoc = onSettingApplied('saveLocation', setDefaultLocation)
    return () => { offSeeding(); offAdd(); offLoc() }
  }, [])
  const applySeedingPolicy = (next: SeedingPolicy) => {
    if (sameSeedingPolicy(seedingPolicy, next)) return
    const saved = writeSeedingPolicy(next)
    setSeedingPolicy(saved)
    void set(SEEDING_POLICY_KEY, saved).catch(() => {})
    runningTorrentClient()?.setSeedingPolicy(saved)
    void recordSetting('seedingPolicy', saved)
  }
  const commitRatio = () => {
    if (skipRatioCommit.current) { skipRatioCommit.current = false; return }
    const fallback = String(seedingPolicy.ratio ?? DEFAULT_SEED_RATIO)
    const parsed = parseSeedRatio(ratioText)
    if (parsed === null) { setRatioText(fallback); return }
    setRatioText(String(parsed))
    if (seedingPolicy.ratio !== null) applySeedingPolicy({ ...seedingPolicy, ratio: parsed })
  }
  const commitMinutes = () => {
    if (skipMinutesCommit.current) { skipMinutesCommit.current = false; return }
    const fallback = String(seedingPolicy.minutes ?? DEFAULT_SEED_MINUTES)
    const parsed = parseSeedMinutes(minutesText)
    if (parsed === null) { setMinutesText(fallback); return }
    setMinutesText(String(parsed))
    if (seedingPolicy.minutes !== null) applySeedingPolicy({ ...seedingPolicy, minutes: parsed })
  }
  const toggleRatio = (enabled: boolean) => {
    if (!enabled) { applySeedingPolicy({ ...seedingPolicy, ratio: null }); return }
    const ratio = parseSeedRatio(ratioText) ?? DEFAULT_SEED_RATIO
    setRatioText(String(ratio))
    applySeedingPolicy({ ...seedingPolicy, ratio })
  }
  const toggleMinutes = (enabled: boolean) => {
    if (!enabled) { applySeedingPolicy({ ...seedingPolicy, minutes: null }); return }
    const minutes = parseSeedMinutes(minutesText) ?? DEFAULT_SEED_MINUTES
    setMinutesText(String(minutes))
    applySeedingPolicy({ ...seedingPolicy, minutes })
  }
  const chooseAddDialog = (on: boolean) => {
    setAddDialog(on)
    try { localStorage.setItem(ADD_DIALOG_KEY, on ? '1' : '0') } catch {}
    void recordSetting('addDialog', on)
  }
  const chooseDefaultLocation = (location: SaveLocation) => {
    setDefaultLocation(location)
    try { localStorage.setItem(SAVE_LOCATION_KEY, location) } catch {}
    if (location === 'browser' || location === 'folder') void recordSetting('saveLocation', location)
  }

  const library = intl.formatMessage({ id: 'Library', defaultMessage: 'Library' })
  const seedingLabel = intl.formatMessage({ id: 'Seeding#a setting', defaultMessage: 'Seeding', description: 'a setting' })
  const whenRatioLabel = intl.formatMessage({ id: 'When ratio reaches', defaultMessage: 'When ratio reaches' })
  const whenMinutesLabel = intl.formatMessage({ id: 'When seeding time reaches', defaultMessage: 'When seeding time reaches' })
  const shareRatioLabel = intl.formatMessage({ id: 'Share ratio', defaultMessage: 'Share ratio' })
  const minutesLabel = intl.formatMessage({ id: 'Minutes', defaultMessage: 'Minutes' })
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
        <div className="folder">
          <span>{seedingLabel}</span>
          <div className="seeding-limits">
            <div className="seeding-limit">
              <label className="seeding-check">
                <input
                  type="checkbox"
                  checked={seedingPolicy.ratio !== null}
                  onChange={(event) => toggleRatio(event.currentTarget.checked)}
                />
                <span>{whenRatioLabel}</span>
              </label>
              <div className="seeding-value">
                <input
                  type="number"
                  inputMode="decimal"
                  min={MIN_SEED_RATIO}
                  max={MAX_SEED_RATIO}
                  step="0.1"
                  disabled={seedingPolicy.ratio === null}
                  aria-label={shareRatioLabel}
                  value={ratioText}
                  onChange={(event) => { setRatioText(event.target.value) }}
                  onBlur={commitRatio}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.currentTarget.blur() }
                    else if (event.key === 'Escape') {
                      skipRatioCommit.current = true
                      setRatioText(String(seedingPolicy.ratio ?? DEFAULT_SEED_RATIO))
                      event.currentTarget.blur()
                    }
                  }}
                />
              </div>
            </div>
            <div className="seeding-limit">
              <label className="seeding-check">
                <input
                  type="checkbox"
                  checked={seedingPolicy.minutes !== null}
                  onChange={(event) => toggleMinutes(event.currentTarget.checked)}
                />
                <span>{whenMinutesLabel}</span>
              </label>
              <div className="seeding-value">
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_SEED_MINUTES}
                  max={MAX_SEED_MINUTES}
                  step="1"
                  disabled={seedingPolicy.minutes === null}
                  aria-label={minutesLabel}
                  value={minutesText}
                  onChange={(event) => { setMinutesText(event.target.value) }}
                  onBlur={commitMinutes}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.currentTarget.blur() }
                    else if (event.key === 'Escape') {
                      skipMinutesCommit.current = true
                      setMinutesText(String(seedingPolicy.minutes ?? DEFAULT_SEED_MINUTES))
                      event.currentTarget.blur()
                    }
                  }}
                />
                <span className="unit">{intl.formatMessage({ id: 'min', defaultMessage: 'min' })}</span>
              </div>
            </div>
          </div>
        </div>
        {folderSupported && (
          <div className="folder">
            <span>{intl.formatMessage({ id: 'Auto-save', defaultMessage: 'Auto-save' })}</span>
            {!folder
              ? <button type="button" onClick={() => { void pickFolder() }}>{intl.formatMessage({ id: 'Choose folder', defaultMessage: 'Choose folder' })}</button>
              : permitted
                ? (
                  <>
                    <button type="button" className="on" dir="auto" onClick={() => { void pickFolder() }}>{folder.name}</button>
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
        <PluginsSection/>
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
