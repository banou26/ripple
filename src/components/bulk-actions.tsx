import type { MouseEvent as ReactMouseEvent } from 'react'

import { css } from '@emotion/react'
import { Check, Download, Layers, Magnet, Pause, Play, Square, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import { hint } from './hint'
import { MenuItems, MenuSurface } from './menu'
import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, DANGER, ELEVATED_BG, EMPHASIS,
  FOCUS_RING, PICKED_WASH, PICTURE_SHADE, TEXT, TEXT_ON_LIGHT,
} from '../theme'

/** A checkbox in a 40 px label, the label being its hit area: each row's box and Select all. */
export const checkStyle = css`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  cursor: pointer;
  /* a shift+click beside the box would select the text from the last click to it */
  user-select: none;

  input {
    width: 18px;
    height: 18px;
    margin: 0;
    cursor: pointer;
    /* the near-white the confirmation's checkbox takes */
    accent-color: ${EMPHASIS};

    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 3px; }
  }
`

/**
 * A ticked row, card or table row: an EMPHASIS edge on its left side and a tint over whatever fill it has, so a row
 * also open in the details keeps that state's border or fill. Background layers take no room, where a border would
 * move the row; an offset inset shadow drew a light line a pixel past the box at a fractional top in Firefox 157, and
 * WebKit 26 draws no shadow on a table row (both measured 2026-11-14).
 */
export const pickedRowStyle = css`
  background-image: linear-gradient(${EMPHASIS}, ${EMPHASIS}), linear-gradient(${PICKED_WASH}, ${PICKED_WASH});
  background-size: 3px 100%, auto;
  background-repeat: no-repeat;
`

/* A ring that reads on any picture, a filled circle with a check once ticked. The label positions the check: an
   absolute child of a flex box sits where justify-content and align-items put it, on the box. */
const overPictureStyle = css`
  input {
    appearance: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid ${EMPHASIS};
    background: none;
    box-shadow: 0 0 0 1px ${PICTURE_SHADE}, inset 0 0 0 1px ${PICTURE_SHADE}, 0 1px 4px ${PICTURE_SHADE};

    &:checked { background: ${EMPHASIS}; box-shadow: 0 0 0 1px ${PICTURE_SHADE}, 0 1px 4px ${PICTURE_SHADE}; }

    /* the outline over a wider shade, so it is seen on a white picture too */
    &:focus-visible { outline-offset: 2px; box-shadow: 0 0 0 6px ${PICTURE_SHADE}; }
  }

  svg {
    position: absolute;
    width: 14px;
    height: 14px;
    color: ${TEXT_ON_LIGHT};
    pointer-events: none;
  }

  input:not(:checked) + svg { display: none; }
`

/**
 * A row's box in the bulk selection, the label being its 40 px hit area. `onChange` is told whether shift was held.
 * `overPicture` draws it as a ring for a card's poster corner.
 *
 * A click inside it stops here, so ticking a row never reaches the row's own click, which is what
 * opens the detail panel.
 */
export const RowCheck = ({ name, checked, onChange, overPicture = false }: {
  name: string
  checked: boolean
  onChange: (shift: boolean) => void
  overPicture?: boolean
}) => {
  const intl = useIntl()
  return (
    <label
      css={[checkStyle, overPicture && overPictureStyle]}
      className="row-check"
      onClick={(e) => {
        e.stopPropagation()
        // a click beside the box is the label's own: Firefox 146 and 157 do not pass one made with shift held on to the
        // box (2026-11-17). Kept here rather than in @banou/ponyfill, which exports only the platform's own names
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        onChange(e.shiftKey)
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        // React fires a box's change from its click, so the event under it carries the keys held
        onChange={(e) => onChange((e.nativeEvent as MouseEvent).shiftKey)}
        aria-label={intl.formatMessage({ id: 'Select {name}', defaultMessage: 'Select {name}' }, { name })}
      />
      {overPicture && <Check aria-hidden="true" strokeWidth={3}/>}
    </label>
  )
}

const CONTROL = 'a, button, input, label, summary'

type RowEvent = ReactMouseEvent<HTMLElement>

/**
 * A row's own click and mousedown. With Ctrl, Cmd or Shift held a click picks the row as its box would, `pick` told
 * whether shift was held, and opens nothing, also on a row that cannot be picked, which `pick` is left to ignore. Any
 * other click, and one on a control of the row's own (a Ctrl+click on a link opens a tab), is `onClick`'s.
 */
export const rowClicks = (pick: (shift: boolean) => void, onClick: (e: RowEvent) => void) => {
  const picking = (e: RowEvent) => (e.ctrlKey || e.metaKey || e.shiftKey) && !(e.target as Element).closest(CONTROL)
  return {
    onClick: (e: RowEvent) => {
      if (picking(e)) pick(e.shiftKey)
      else onClick(e)
    },
    // the press would otherwise select text: from the last click with shift held, and in Firefox 157 the table cell
    // under a Ctrl+click (2026-11-18). Prevented, it no longer takes the focus off a field either, which would then
    // keep the Escape that clears the picks
    onMouseDown: (e: RowEvent) => {
      if (e.button !== 0 || !picking(e)) return
      e.preventDefault()
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    },
  }
}

const barStyle = css`
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px 6px 14px;
  border-radius: 8px;
  /* floats over the list's end, so it takes the floating pair of tokens */
  background: ${ELEVATED_BG};
  border: 1px solid ${BORDER_STRONG};
  color: ${TEXT};
  font-size: 0.85rem;

  .count {
    margin-right: auto;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 36px;
    height: 36px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
    font: inherit;
    font-weight: 700;

    svg { width: 16px; height: 16px; flex: none; }

    &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }

    &:disabled { opacity: 0.4; cursor: default; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }

    /* the confirmation's danger button: a red label and hairline on the neutral fill */
    &.danger { color: ${DANGER}; border-color: ${DANGER}; }

    &.icon { padding: 0; }
  }

  /* a phone keeps one row: Remove shows its icon like the others, the gaps narrow, and the count gives way first,
     since its width depends on the language and the font */
  @media (max-width: 700px) {
    flex-wrap: nowrap;
    gap: 4px;
    padding-left: 8px;

    .count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    button { min-width: 40px; height: 40px; }
    button.danger { padding: 0; }
    button.danger span { display: none; }
  }
`

export type BulkBarProps = {
  count: number
  /** Whether Pause or Resume would change anything for the ticked rows; each is disabled otherwise. */
  canPause: boolean
  canResume: boolean
  /** Whether every ticked torrent is finished, so the two say Stop and Start. */
  finished?: boolean
  /** Whether a ticked torrent is not on this device, which is when Download shows. */
  canDownload?: boolean
  onDownload?: () => void
  /** Copies the ticked torrents' magnets; absent while they are being read, which disables it. */
  onCopyMagnets?: () => void
  /** Each group, `holds` when every ticked torrent is in it, for the Groups menu. */
  groups: { id: string, name: string, holds: boolean }[]
  /** Puts every ticked torrent in the group, or takes them all out of it. */
  onGroup: (id: string, put: boolean) => void
  onNewGroup: () => void
  onPause: () => void
  onResume: () => void
  onRemove: () => void
  onClear: () => void
}

/** What can be done to every ticked torrent at once, shown while any is ticked. */
export const BulkBar = ({
  count, canPause, canResume, finished, canDownload, onDownload, onCopyMagnets, groups, onGroup, onNewGroup, onPause, onResume, onRemove, onClear,
}: BulkBarProps) => {
  const intl = useIntl()
  const [grouping, setGrouping] = useState(false)
  const groupsButton = useRef<HTMLButtonElement>(null)
  const groupsWord = intl.formatMessage({ id: 'Groups', defaultMessage: 'Groups' })
  const download = intl.formatMessage({ id: 'Download#verb', defaultMessage: 'Download', description: 'verb' })
  const pause = finished ? intl.formatMessage({ id: 'Stop', defaultMessage: 'Stop' }) : intl.formatMessage({ id: 'Pause', defaultMessage: 'Pause' })
  const resume = finished ? intl.formatMessage({ id: 'Start', defaultMessage: 'Start' }) : intl.formatMessage({ id: 'Resume', defaultMessage: 'Resume' })
  const clear = intl.formatMessage({ id: 'Clear selection', defaultMessage: 'Clear selection' })
  const copyMagnets = intl.formatMessage({ id: 'Copy magnets', defaultMessage: 'Copy magnets' })
  const remove = intl.formatMessage({ id: 'Remove', defaultMessage: 'Remove' })
  return (
    <>
      <div css={barStyle} className="bulk-bar">
        <span className="count" role="status">
          {intl.formatMessage({ id: '{count, plural, one {{count} selected} other {{count} selected}}', defaultMessage: '{count, plural, one {{count} selected} other {{count} selected}}' }, { count })}
        </span>
        {canDownload && (
          <button type="button" className="icon" onClick={onDownload} aria-label={download} {...hint(download)}>
            <Download aria-hidden="true"/>
          </button>
        )}
        <button type="button" className="icon" disabled={!canPause} onClick={onPause} aria-label={pause} {...hint(pause)}>
          {finished ? <Square aria-hidden="true"/> : <Pause aria-hidden="true"/>}
        </button>
        <button type="button" className="icon" disabled={!canResume} onClick={onResume} aria-label={resume} {...hint(resume)}>
          <Play aria-hidden="true"/>
        </button>
        <button type="button" className="icon" disabled={!onCopyMagnets} onClick={onCopyMagnets} aria-label={copyMagnets} {...hint(copyMagnets)}>
          <Magnet aria-hidden="true"/>
        </button>
        <button
          type="button" className="icon" ref={groupsButton} aria-haspopup="menu" aria-expanded={grouping}
          onClick={() => setGrouping((was) => !was)} aria-label={groupsWord} {...hint(groupsWord)}
        >
          <Layers aria-hidden="true"/>
        </button>
        <button type="button" className="danger" onClick={onRemove} aria-label={remove}>
          <Trash2 aria-hidden="true"/><span>{remove}</span>
        </button>
        <button type="button" className="icon" onClick={onClear} aria-label={clear} {...hint(clear)}>
          <X aria-hidden="true"/>
        </button>
      </div>
      {/* beside the bar, so none of the bar's button rules reach the menu's rows */}
      {grouping && (
        <MenuSurface placement={{ kind: 'under', of: groupsButton, align: 'end' }} label={groupsWord} onClose={() => setGrouping(false)}>
          <MenuItems
            groups={[{
              id: 'groups',
              label: groupsWord,
              items: [
                ...groups.map((g) => ({ kind: 'toggle' as const, id: g.id, label: g.name, checked: g.holds, apply: (on: boolean) => onGroup(g.id, on) })),
                { kind: 'action' as const, id: 'new-group', label: intl.formatMessage({ id: 'New group...', defaultMessage: 'New group...' }), run: onNewGroup },
              ],
            }]}
            onChose={() => setGrouping(false)}
          />
        </MenuSurface>
      )}
    </>
  )
}
