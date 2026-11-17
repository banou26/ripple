import { css } from '@emotion/react'
import { useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import { confirmStyle } from './confirm-dialog'
import { Modal } from './modal'
import { BORDER_INTERACTIVE, FOCUS_RING, SUNKEN_BG, TEXT, TEXT_MUTED } from '../theme'

const nameStyle = css`
  .name {
    display: block;
    margin-top: 12px;
    font-size: 0.82rem;
    color: ${TEXT_MUTED};
    cursor: default;
    /* the card's label rule is for a checkbox, whose text is not for selecting; this one holds a field */
    user-select: auto;
  }

  .name input {
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid ${BORDER_INTERACTIVE};
    background: ${SUNKEN_BG};
    color: ${TEXT};
    font: inherit;
    font-size: 0.9rem;
    cursor: text;

    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }
  }

  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
`

/**
 * Names a group: a new one, titled New group, or one being renamed, titled with its name and holding it. Save is
 * offered once the name, trimmed, is not empty and not the one it had; `onSave` gets it trimmed.
 */
export const GroupNameDialog = ({ title, name: was = '', onCancel, onSave }: {
  title: string
  name?: string
  onCancel: () => void
  onSave: (name: string) => void
}) => {
  const intl = useIntl()
  const [name, setName] = useState(was)
  const input = useRef<HTMLInputElement>(null)
  const ready = !!name.trim() && name.trim() !== was
  return (
    <Modal labelledBy="group-name-title" onClose={onCancel} initialFocus={input}>
      <div css={[confirmStyle, nameStyle]}>
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (ready) onSave(name.trim()) }}>
          <h2 id="group-name-title" dir="auto">{title}</h2>
          <label className="name">
            {intl.formatMessage({ id: 'Name', defaultMessage: 'Name' })}
            <input ref={input} value={name} onChange={(e) => setName(e.target.value)} dir="auto" spellCheck={false} autoComplete="off"/>
          </label>
          <div className="actions">
            <button type="button" onClick={onCancel}>{intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}</button>
            <button type="submit" disabled={!ready}>{intl.formatMessage({ id: 'Save', defaultMessage: 'Save' })}</button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

/**
 * A group someone sent by link: its name, which a stranger chose, and how many torrents Add puts in the list. Cancel,
 * first, has the focus, as in the add dialog, since the proposal is someone else's.
 */
export const GroupLinkDialog = ({ name, count, onCancel, onAdd }: {
  name: string
  count: number
  onCancel: () => void
  onAdd: () => void
}) => {
  const intl = useIntl()
  return (
    <Modal labelledBy="group-link-title" onClose={onCancel}>
      <div css={confirmStyle}>
        <div className="card">
          <h2 id="group-link-title" dir="auto">{name}</h2>
          <p>{intl.formatMessage({ id: '{count, plural, one {{count} torrent} other {{count} torrents}}', defaultMessage: '{count, plural, one {{count} torrent} other {{count} torrents}}' }, { count })}</p>
          <div className="actions">
            <button type="button" onClick={onCancel}>{intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}</button>
            <button type="button" onClick={onAdd}>{intl.formatMessage({ id: 'Add', defaultMessage: 'Add' })}</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
