import type { ListFilter, SortDir, SortKey, ViewMode } from '../torrent/list-view'

import { css } from '@emotion/react'
import { ArrowDown, ArrowUp, LayoutGrid, List as ListIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useIntl } from 'react-intl'

import { FILTER_LABEL, NATURAL_DIR, SORT_LABEL, offeredFilters } from '../torrent/list-view'
import { checkStyle } from './bulk-actions'
import { hint } from './hint'
import {
  BORDER, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  FOCUS_RING, SUNKEN_BG, TEXT, TEXT_MUTED,
} from '../theme'

/**
 * What is shown, in what order, and in which shape.
 *
 * Self contained, because it is mounted by home and tested on its own. Everything here reports state
 * upward and holds none: the three preferences are persisted by the page, and a control that
 * remembered its own answer would eventually disagree with the list it claims to describe, which is
 * the rule torrent-options.ts already states for itself.
 */
const style = css`
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin: 14px 16px 0;

  /* the box's 40 px hit area pulled into the margin, so the row keeps its height */
  .pick-all {
    margin: -5px -10px -5px -8px;

    input:disabled { cursor: default; }
  }

  .seg {
    display: flex;
    gap: 3px;
    padding: 3px;
    border-radius: 6px;
    background: ${SUNKEN_BG};

    button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: none;
      border-radius: 4px;
      background: none;
      color: ${TEXT_MUTED};
      padding: 5px 12px;
      font: inherit;
      font-size: 0.75rem;
      font-weight: 700;
      cursor: pointer;

      svg { width: 14px; height: 14px; }

      /* stated before the selected rule so a selected button's fill is not painted over by a hover
         of equal specificity */
      &:hover { color: ${TEXT}; }

      &[data-on] {
        background: ${CONTROL_ACTIVE_BG};
        color: ${TEXT};
      }

      &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px ${FOCUS_RING};
      }
    }
  }

  label.show, label.sort {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${TEXT_MUTED};
  }

  select {
    font: inherit;
    font-size: 0.8rem;
    color: ${TEXT};
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER};
    border-radius: 4px;
    padding: 5px 8px;
    cursor: pointer;

    &:hover { border-color: ${BORDER_STRONG}; background: ${CONTROL_HOVER_BG}; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }
  }

  .dir {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 4px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
    cursor: pointer;

    svg { width: 14px; height: 14px; }

    &:hover { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }
  }

  /* pushed to the far end: it changes the shape of the page rather than its contents */
  .views { margin-left: auto; }

  /*
   * A phone keeps two rows in every language: the box, Show and the views (as icons) on the first, Sort and its
   * direction on the second. A select longer than its row narrows to the room left rather than wrapping a third row.
   * Above 560 px the wrapping row keeps to two in every language (German's Sort row is the widest, at 555 px).
   */
  @media (max-width: 560px) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'pick show views' 'sort sort dir';

    .pick-all { grid-area: pick; }
    label.show { grid-area: show; }
    label.sort { grid-area: sort; }
    label.show, label.sort { justify-self: start; min-width: 0; max-width: 100%; }
    select { min-width: 0; }
    .dir { grid-area: dir; justify-self: end; }
    .views { grid-area: views; margin-left: 0; }
    .views span { display: none; }
  }
`

export type ListToolbarProps = {
  filter: ListFilter
  onFilter: (filter: ListFilter) => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  view: ViewMode
  onView: (view: ViewMode) => void
  /** How many rows each filter shows, which also decides the ones offered: see `offeredFilters`. */
  counts: Record<ListFilter, number>
  /** How many of the rows shown are ticked for a bulk action; the box ticks them all or none. */
  picked: 'none' | 'some' | 'all'
  /** False when no row shown can be ticked, which disables the box. */
  canPick: boolean
  onPickAll: () => void
}

export const ListToolbar = (
  { filter, onFilter, sortKey, sortDir, onSort, view, onView, counts, picked, canPick, onPickAll }: ListToolbarProps,
) => {
  const intl = useIntl()
  const pickAll = useRef<HTMLInputElement>(null)
  // a property with no attribute, so React cannot set it
  useEffect(() => { if (pickAll.current) pickAll.current.indeterminate = picked === 'some' }, [picked])
  const selectAll = intl.formatMessage({ id: 'Select all', defaultMessage: 'Select all' })
  const show = intl.formatMessage({ id: 'Show#verb', defaultMessage: 'Show', description: 'verb' })
  const cards = intl.formatMessage({ id: 'Cards', defaultMessage: 'Cards' })
  const table = intl.formatMessage({ id: 'Table', defaultMessage: 'Table' })
  return <div css={style} className="list-toolbar">
    <label css={checkStyle} className="pick-all" {...hint(selectAll)}>
      <input
        ref={pickAll}
        type="checkbox"
        checked={picked === 'all'}
        disabled={!canPick}
        onChange={onPickAll}
        aria-label={selectAll}
      />
    </label>

    {/*
      * Native selects rather than the app's own menu. Each is one of a few mutually exclusive values
      * with no icons and no per-item state, which is what a select is for, and it brings keyboard
      * handling, type-ahead and a touch picker that none of this code has to own.
      */}
    <label className="show">
      {show}
      <select aria-label={show} value={filter} onChange={(e) => onFilter(e.target.value as ListFilter)}>
        {offeredFilters(counts, filter).map((f) => (
          <option key={f} value={f}>
            {intl.formatMessage({ id: '{filter} ({count})', defaultMessage: '{filter} ({count})' }, { filter: intl.formatMessage(FILTER_LABEL[f]), count: counts[f] })}
          </option>
        ))}
      </select>
    </label>

    <label className="sort">
      {intl.formatMessage({ id: 'Sort', defaultMessage: 'Sort' })}
      <select
        aria-label={intl.formatMessage({ id: 'Sort by', defaultMessage: 'Sort by' })}
        value={sortKey}
        onChange={(e) => {
          const key = e.target.value as SortKey
          // the direction that answers the question somebody had when they picked the key: newest,
          // biggest, fastest, soonest. Flipping it stays available right beside this.
          onSort(key, NATURAL_DIR[key])
        }}
      >
        {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
          <option key={k} value={k}>{intl.formatMessage(SORT_LABEL[k])}</option>
        ))}
      </select>
    </label>

    <button
      type="button" className="dir"
      aria-label={sortDir === 'asc'
        ? intl.formatMessage({ id: 'Sorted ascending, click for descending', defaultMessage: 'Sorted ascending, click for descending' })
        : intl.formatMessage({ id: 'Sorted descending, click for ascending', defaultMessage: 'Sorted descending, click for ascending' })}
      {...hint(sortDir === 'asc'
        ? intl.formatMessage({ id: 'Smallest first', defaultMessage: 'Smallest first' })
        : intl.formatMessage({ id: 'Largest first', defaultMessage: 'Largest first' }))}
      onClick={() => onSort(sortKey, sortDir === 'asc' ? 'desc' : 'asc')}
    >
      {sortDir === 'asc' ? <ArrowUp/> : <ArrowDown/>}
    </button>

    <div className="seg views" role="group" aria-label={intl.formatMessage({ id: 'View', defaultMessage: 'View' })}>
      <button
        type="button" data-on={view === 'cards' || undefined} aria-pressed={view === 'cards'}
        aria-label={cards} onClick={() => onView('cards')}
      ><LayoutGrid/><span>{cards}</span></button>
      <button
        type="button" data-on={view === 'table' || undefined} aria-pressed={view === 'table'}
        aria-label={table} onClick={() => onView('table')}
      ><ListIcon/><span>{table}</span></button>
    </div>
  </div>
}
