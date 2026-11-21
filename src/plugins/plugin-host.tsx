import type { IntlShape } from 'react-intl'
import type { Asking } from './host'
import type { Switch } from './contract'
import type { TorrentClient } from '../torrent/client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIntl } from 'react-intl'
import { useLocation } from 'react-router-dom'

import { confirmStyle } from '../components/confirm-dialog'
import { Modal } from '../components/modal'
import { toastStyle } from '../components/toast'
import { runningTorrentClient } from '../torrent/client'
import { cancelAsking, connectAnswered, connectInstalled, finishAsking, pluginsHere, usePlugins, usePluginsHere } from './host'
import { PluginPage } from './plugin-page'
import { subscribeAnswers } from './switches'

/** A switch's name as the person reads it. */
export const switchLabel = (intl: IntlShape, name: Switch): string =>
  name === 'read' ? intl.formatMessage({ id: 'See your torrents', defaultMessage: 'See your torrents' })
    : name === 'add' ? intl.formatMessage({ id: 'Add torrents without asking', defaultMessage: 'Add torrents without asking' })
      : intl.formatMessage({ id: 'Pause, resume and organize torrents', defaultMessage: 'Pause, resume and organize torrents' })

/** Asks which of a new plugin's switches to turn on, each starting off. Cancel, Escape and the backdrop uninstall it. */
const Sheet = ({ asking }: { asking: Asking }) => {
  const intl = useIntl()
  const [on, setOn] = useState<Switch[]>([])
  const done = useRef<HTMLButtonElement>(null)
  const ready = asking.asks !== null || asking.failed
  const flip = (name: Switch, value: boolean) => setOn((was) => (value ? [...was, name] : was.filter((n) => n !== name)))
  return (
    <Modal labelledBy="plugin-sheet-title" onClose={() => { void cancelAsking() }} initialFocus={done}>
      <div css={confirmStyle}>
        <div className="card">
          <h2 id="plugin-sheet-title" dir="auto">{asking.name}</h2>
          {asking.failed
            ? <p role="alert">{intl.formatMessage({ id: 'Not responding', defaultMessage: 'Not responding' })}</p>
            : !ready && <p role="status">{intl.formatMessage({ id: 'Connecting', defaultMessage: 'Connecting' })}</p>}
          {asking.asks?.map((name) => (
            <label key={name}>
              <input type="checkbox" checked={on.includes(name)} onChange={(event) => flip(name, event.currentTarget.checked)}/>
              {switchLabel(intl, name)}
            </label>
          ))}
          <div className="actions">
            <button type="button" onClick={() => { void cancelAsking() }}>
              {intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}
            </button>
            <button type="button" ref={done} disabled={!ready} onClick={() => { void finishAsking(on) }}>
              {intl.formatMessage({ id: 'Done#button', defaultMessage: 'Done', description: 'button' })}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** The install sheet, open popup page, and the line saying a plugin did not answer a click. */
export const InstallSheet = () => {
  const intl = useIntl()
  const { asking, openPage, unanswered } = usePlugins()
  return (
    <>
      {openPage && <PluginPage key={openPage.key} page={openPage}/>}
      {asking && <Sheet key={asking.uri} asking={asking}/>}
      {unanswered && createPortal(
        <div role="status" className="toast" css={toastStyle}>
          {intl.formatMessage({ id: '{name} is not responding', defaultMessage: '{name} is not responding' }, { name: unanswered })}
        </div>,
        document.body,
      )}
    </>
  )
}

// the tab running the engine connects every plugin, and each one answered for in another tab
const EngineTab = ({ client }: { client: TorrentClient }) => {
  useEffect(() => {
    let owns = false
    const offOwner = client.onOwnership((now) => {
      owns = now
      if (now) void connectInstalled()
    })
    const offAnswers = subscribeAnswers(() => { if (owns) void connectAnswered() })
    return () => { offOwner(); offAnswers() }
  }, [client])
  return null
}

/**
 * The plugins of this tab, mounted around every page so their connections outlive a move between the library and
 * Settings. It asks fkn.app once, at start, whether plugins are on here (`pluginsHere`, host.ts), and mounts nothing
 * until they are, then waits for a page to make the client, as the folder's work does.
 */
export const PluginHost = () => {
  useLocation()
  useEffect(() => { void pluginsHere() }, [])
  const here = usePluginsHere()
  const client = runningTorrentClient()
  if (!here) return null
  return (
    <>
      {client && <EngineTab client={client}/>}
      <InstallSheet/>
    </>
  )
}
