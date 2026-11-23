import { css } from '@emotion/react'
import { Folder, ImagePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import type { GroupIcon } from '../torrent/group-appearance'

import { DEFAULT_ICON, groupImageKey, PRESET_ICONS } from '../torrent/group-appearance'
import { useThumbnail } from '../torrent/use-thumbnails'
import { confirmStyle } from './confirm-dialog'
import { PRESET_ICON_COMPONENTS, presetIconLabel } from './group-icon'
import { Modal } from './modal'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  FOCUS_RING, SUNKEN_BG, TEXT, TEXT_MUTED,
} from '../theme'

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

  .icon-picker {
    margin-top: 14px;

    .picker-label {
      display: block;
      font-size: 0.82rem;
      color: ${TEXT_MUTED};
      margin-bottom: 8px;
    }

    .icon-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .icon-choice {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 34px;
      height: 34px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT_MUTED};
      font: inherit;
      font-size: 0.78rem;
      cursor: pointer;

      &:hover { background: ${CONTROL_HOVER_BG}; color: ${TEXT}; border-color: ${BORDER_STRONG}; }
      &[aria-pressed='true'] { background: ${CONTROL_ACTIVE_BG}; color: ${TEXT}; border-color: ${FOCUS_RING}; box-shadow: 0 0 0 1px ${FOCUS_RING}; }
      &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }
    }

    .image-preview {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      object-fit: cover;
      display: block;
    }

    input[type='file'] {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
  }

  .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
`

export type GroupSaveResult = {
  name: string
  icon: GroupIcon
  imageFile: File | null
}

/**
 * Creates or edits a group: name, optional built-in icon or custom image upload, or auto thumbnail collage.
 * Save is offered once the trimmed name is non-empty and either the name, icon, or uploaded file changed.
 */
export const GroupNameDialog = ({
  title,
  groupId,
  name: was = '',
  icon: initialIcon = DEFAULT_ICON,
  onCancel,
  onSave,
}: {
  title: string
  groupId?: string
  name?: string
  icon?: GroupIcon
  onCancel: () => void
  onSave: (result: GroupSaveResult) => void
}) => {
  const intl = useIntl()
  const [name, setName] = useState(was)
  const [icon, setIcon] = useState<GroupIcon>(initialIcon)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const existingImage = useThumbnail(groupId && initialIcon.kind === 'image' ? groupImageKey(groupId, initialIcon.hash) : undefined)
  const input = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!imageFile) { setPreviewUrl(null); return }
    const url = URL.createObjectURL(imageFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile])

  const trimmed = name.trim()
  const iconChanged = JSON.stringify(icon) !== JSON.stringify(initialIcon)
  const ready = !!trimmed && (trimmed !== was || iconChanged || !!imageFile)
  const autoActive = !imageFile && icon.kind === 'default'
  const imageActive = !!imageFile || icon.kind === 'image'
  const shownPreview = previewUrl ?? (icon.kind === 'image' ? existingImage : null)

  return (
    <Modal labelledBy="group-name-title" onClose={onCancel} initialFocus={input}>
      <div css={[confirmStyle, nameStyle]}>
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (ready) onSave({ name: trimmed, icon, imageFile }) }}>
          <h2 id="group-name-title" dir="auto">{title}</h2>
          <label className="name">
            {intl.formatMessage({ id: 'Name', defaultMessage: 'Name' })}
            <input ref={input} value={name} onChange={(e) => setName(e.target.value)} dir="auto" spellCheck={false} autoComplete="off"/>
          </label>
          <div className="icon-picker">
            <span className="picker-label">{intl.formatMessage({ id: 'Icon', defaultMessage: 'Icon' })}</span>
            <div className="icon-grid" role="group" aria-label={intl.formatMessage({ id: 'Icon', defaultMessage: 'Icon' })}>
              <button
                type="button"
                className="icon-choice"
                aria-pressed={autoActive}
                onClick={() => { setImageFile(null); setIcon(DEFAULT_ICON) }}
              >
                <Folder size={15} aria-hidden="true"/>
                <span>{intl.formatMessage({ id: 'Auto', defaultMessage: 'Auto' })}</span>
              </button>
              {PRESET_ICONS.map((preset) => {
                const Icon = PRESET_ICON_COMPONENTS[preset]
                const active = !imageFile && icon.kind === 'preset' && icon.icon === preset
                return (
                  <button
                    key={preset}
                    type="button"
                    className="icon-choice"
                    aria-label={presetIconLabel(preset, intl)}
                    aria-pressed={active}
                    onClick={() => { setImageFile(null); setIcon({ kind: 'preset', icon: preset }) }}
                  >
                    <Icon size={16} aria-hidden/>
                  </button>
                )
              })}
              <button
                type="button"
                className="icon-choice"
                aria-pressed={imageActive}
                aria-label={intl.formatMessage({ id: 'Custom image', defaultMessage: 'Custom image' })}
                onClick={() => fileInput.current?.click()}
              >
                {shownPreview
                  ? <img className="image-preview" src={shownPreview} alt=""/>
                  : <ImagePlus size={15} aria-hidden="true"/>}
                <span>{intl.formatMessage({ id: 'Image', defaultMessage: 'Image' })}</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) setImageFile(file)
                  e.target.value = ''
                }}
              />
            </div>
          </div>
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
