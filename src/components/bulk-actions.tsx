import { css } from '@emotion/react'
import { Pause, Play, Trash2, X } from 'lucide-react'
import { useIntl } from 'react-intl'

import { hint } from './hint'
import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, DANGER, ELEVATED_BG, EMPHASIS,
  FOCUS_RING, SURFACE_BG, TEXT,
} from '../theme'

const checkStyle = css`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  cursor: pointer;

  input {
    width: 18px;
    height: 18px;
    margin: 0;
    cursor: pointer;
    /* the near-white the confirmation's checkbox takes, and a ring of the surface so it reads over a poster */
    accent-color: ${EMPHASIS};
    box-shadow: 0 0 0 3px ${SURFACE_BG};

    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 3px; }
  }
`

/**
 * A row's box in the bulk selection, the label being its 40 px hit area.
 *
 * A click inside it stops here, so ticking a row never reaches the row's own click, which is what
 * opens the detail panel.
 */
export const RowCheck = ({ name, checked, onChange }: { name: string, checked: boolean, onChange: () => void }) => {
  const intl = useIntl()
  return (
    <label css={checkStyle} className="row-check" onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={intl.formatMessage({ id: 'Select {name}', defaultMessage: 'Select {name}' }, { name })}
      />
    </label>
  )
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

  @media (max-width: 700px) {
    button { min-width: 40px; height: 40px; }
  }
`

export type BulkBarProps = {
  count: number
  /** Whether Pause or Resume would change anything for the ticked rows; each is disabled otherwise. */
  canPause: boolean
  canResume: boolean
  onPause: () => void
  onResume: () => void
  onRemove: () => void
  onClear: () => void
}

/** What can be done to every ticked torrent at once, shown while any is ticked. */
export const BulkBar = ({ count, canPause, canResume, onPause, onResume, onRemove, onClear }: BulkBarProps) => {
  const intl = useIntl()
  const pause = intl.formatMessage({ id: 'Pause', defaultMessage: 'Pause' })
  const resume = intl.formatMessage({ id: 'Resume', defaultMessage: 'Resume' })
  const clear = intl.formatMessage({ id: 'Clear selection', defaultMessage: 'Clear selection' })
  return (
    <div css={barStyle} className="bulk-bar">
      <span className="count" role="status">
        {intl.formatMessage({ id: '{count, plural, one {{count} selected} other {{count} selected}}', defaultMessage: '{count, plural, one {{count} selected} other {{count} selected}}' }, { count })}
      </span>
      <button type="button" className="icon" disabled={!canPause} onClick={onPause} aria-label={pause} {...hint(pause)}>
        <Pause aria-hidden="true"/>
      </button>
      <button type="button" className="icon" disabled={!canResume} onClick={onResume} aria-label={resume} {...hint(resume)}>
        <Play aria-hidden="true"/>
      </button>
      <button type="button" className="danger" onClick={onRemove}>
        <Trash2 aria-hidden="true"/>{intl.formatMessage({ id: 'Remove', defaultMessage: 'Remove' })}
      </button>
      <button type="button" className="icon" onClick={onClear} aria-label={clear} {...hint(clear)}>
        <X aria-hidden="true"/>
      </button>
    </div>
  )
}
