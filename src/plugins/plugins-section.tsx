import type { InstalledPackage } from '@fkn/lib/packages'
import type { Switch } from './contract'

import { css } from '@emotion/react'
import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'

import { useConfirm } from '../components/confirm-dialog'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG, DANGER, FOCUS_RING, TEXT,
  TEXT_MUTED,
} from '../theme'
import { addByAddress, browsePlugins, listPlugins, removePlugin, updatePlugin, usePlugins } from './host'
import { switchLabel } from './plugin-host'
import { answer, anyPlugin, OFFERED_SWITCHES, useAnswers } from './switches'

const style = css`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 0;
  border-bottom: 1px solid ${BORDER};

  .find {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;

    > span {
      flex: 0 0 9rem;
      font-size: 0.85rem;
      font-weight: 700;
      color: ${TEXT_MUTED};
    }
  }

  form {
    display: flex;
    flex: 1 1 14rem;
    gap: 8px;
    min-width: 0;
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    /* an address runs left to right in a right to left page, and its placeholder takes the page's side */
    unicode-bidi: plaintext;
    text-overflow: ellipsis;
    font: inherit;
    font-size: 0.85rem;
    padding: 7px 10px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
  }

  button {
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

    &.on {
      background: ${CONTROL_ACTIVE_BG};
      border-color: ${BORDER_INTERACTIVE};
    }

    &.danger {
      border-color: ${DANGER};
      color: ${DANGER};
    }
  }

  button, input {
    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px ${FOCUS_RING};
    }
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid ${BORDER};
    border-radius: 6px;
  }

  .head, .controls {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  .name {
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .version, .status, p {
    margin: 0;
    font-size: 0.8rem;
    color: ${TEXT_MUTED};
  }
`

const Row = ({ plugin }: { plugin: InstalledPackage }) => {
  const intl = useIntl()
  const { statuses, asks } = usePlugins()
  const answers = useAnswers()?.[plugin.uri] ?? {}
  const { confirm, confirmElement } = useConfirm()
  const [current, setCurrent] = useState(false)
  // what it asks now, and whatever was answered before, so a switch turned on never goes out of sight
  const shown = OFFERED_SWITCHES.filter((name) => name in answers || asks[plugin.uri]?.includes(name))
  const status = statuses[plugin.uri]
  const flip = (name: Switch) => { void answer(plugin.uri, { [name]: answers[name] !== true }) }
  const update = async () => setCurrent(!(await updatePlugin(plugin.uri)))
  const remove = async () => {
    const ok = await confirm({
      title: intl.formatMessage({ id: 'Remove {name}?', defaultMessage: 'Remove {name}?' }, { name: plugin.name }),
      body: intl.formatMessage({ id: 'Its data in Ripple is deleted.', defaultMessage: 'Its data in Ripple is deleted.' }),
      confirmLabel: intl.formatMessage({ id: 'Remove', defaultMessage: 'Remove' }),
      tone: 'danger',
    })
    if (ok) await removePlugin(plugin.uri)
  }
  return (
    <li>
      <div className="head">
        <span className="name" dir="auto">{plugin.name}</span>
        {plugin.version && <span className="version" dir="ltr">{plugin.version}</span>}
        {status === 'failed' && <span className="status">{intl.formatMessage({ id: 'Not responding', defaultMessage: 'Not responding' })}</span>}
        {status === 'connecting' && <span className="status">{intl.formatMessage({ id: 'Connecting', defaultMessage: 'Connecting' })}</span>}
      </div>
      {shown.length > 0 && (
        <div className="controls">
          {shown.map((name) => (
            <button key={name} type="button" className={answers[name] ? 'on' : undefined} aria-pressed={answers[name] === true} onClick={() => flip(name)}>
              {switchLabel(intl, name)}
            </button>
          ))}
        </div>
      )}
      <div className="controls">
        <button type="button" onClick={() => { void update() }}>{intl.formatMessage({ id: 'Update', defaultMessage: 'Update' })}</button>
        <button type="button" className="danger" onClick={() => { void remove() }}>{intl.formatMessage({ id: 'Remove', defaultMessage: 'Remove' })}</button>
      </div>
      {current && <p role="status">{intl.formatMessage({ id: 'Up to date', defaultMessage: 'Up to date' })}</p>}
      {confirmElement}
    </li>
  )
}

/** Settings' plugins: FKN's picker, an add by address, and each plugin's switches, version, Update and Remove. */
export const PluginsSection = () => {
  const intl = useIntl()
  const { installed } = usePlugins()
  const [address, setAddress] = useState('')
  const [refused, setRefused] = useState(false)
  // FKN is asked only once this device has a plugin, or on a press
  useEffect(() => { void anyPlugin().then((any) => { if (any) void listPlugins() }) }, [])
  const add = async () => {
    if (!address.trim()) return
    const ok = await addByAddress(address)
    setRefused(!ok)
    if (ok) setAddress('')
  }
  const label = intl.formatMessage({ id: 'Plugin address', defaultMessage: 'Plugin address' })
  return (
    <section css={style} aria-labelledby="plugins-title">
      <div className="find">
        <span id="plugins-title">{intl.formatMessage({ id: 'Plugins', defaultMessage: 'Plugins' })}</span>
        <button type="button" onClick={() => { void browsePlugins() }}>{intl.formatMessage({ id: 'Browse', defaultMessage: 'Browse' })}</button>
        <form onSubmit={(event) => { event.preventDefault(); void add() }}>
          <input value={address} onChange={(event) => setAddress(event.currentTarget.value)} aria-label={label} placeholder={label} spellCheck={false} autoComplete="off"/>
          <button type="submit">{intl.formatMessage({ id: 'Add', defaultMessage: 'Add' })}</button>
        </form>
      </div>
      {refused && <p role="alert">{intl.formatMessage({ id: 'That plugin could not be added', defaultMessage: 'That plugin could not be added' })}</p>}
      {!!installed?.length && (
        <ul>
          {installed.map((plugin) => <Row key={plugin.uri} plugin={plugin}/>)}
        </ul>
      )}
    </section>
  )
}
