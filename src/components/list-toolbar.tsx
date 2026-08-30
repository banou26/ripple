import type { ListFilter, SortDir, SortKey, ViewMode } from '../torrent/list-view'

import { css } from '@emotion/react'
import { ArrowDown, ArrowUp, Grid, List as ListIcon } from 'react-feather'

import { NATURAL_DIR, SORT_LABEL, TEMPORARY_HINT } from '../torrent/list-view'
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

      .count {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        opacity: 0.85;
      }
    }
  }

  label.sort {
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
`

export type ListToolbarProps = {
  filter: ListFilter
  onFilter: (filter: ListFilter) => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  view: ViewMode
  onView: (view: ViewMode) => void
  /** How many temporary downloads exist, which decides whether the filter is worth showing at all. */
  temporaryCount: number
}

export const ListToolbar = (
  { filter, onFilter, sortKey, sortDir, onSort, view, onView, temporaryCount }: ListToolbarProps,
) => (
  <div css={style} className="list-toolbar">
    {/*
      * Hidden entirely when nothing is temporary, which is the state most people are in for good.
      * An option that cannot change an outcome is not shown, and a filter offering to hide a
      * category with nothing in it teaches the wrong thing about what the app is doing.
      */}
    {temporaryCount > 0 && (
      <div className="seg" role="group" aria-label="Show">
        <button
          type="button" data-on={filter === 'all' || undefined} aria-pressed={filter === 'all'}
          onClick={() => onFilter('all')} title="Everything in your library."
        >All</button>
        <button
          type="button" data-on={filter === 'library' || undefined} aria-pressed={filter === 'library'}
          onClick={() => onFilter('library')}
          title="Only the downloads you keep. Ripple never deletes these on its own."
        >Kept</button>
        <button
          type="button" data-on={filter === 'temporary' || undefined} aria-pressed={filter === 'temporary'}
          onClick={() => onFilter('temporary')} title={TEMPORARY_HINT}
        >Temporary <span className="count">{temporaryCount}</span></button>
      </div>
    )}

    {/*
      * A native select rather than the app's own menu. It is one of eight mutually exclusive values
      * with no icons and no per-item state, which is what a select is for, and it brings keyboard
      * handling, type-ahead and a touch picker that none of this code has to own.
      */}
    <label className="sort">
      Sort
      <select
        aria-label="Sort by"
        value={sortKey}
        onChange={(e) => {
          const key = e.target.value as SortKey
          // the direction that answers the question somebody had when they picked the key: newest,
          // biggest, fastest, soonest. Flipping it stays available right beside this.
          onSort(key, NATURAL_DIR[key])
        }}
      >
        {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
          <option key={k} value={k}>{SORT_LABEL[k]}</option>
        ))}
      </select>
    </label>

    <button
      type="button" className="dir"
      aria-label={sortDir === 'asc' ? 'Sorted ascending, click for descending' : 'Sorted descending, click for ascending'}
      title={sortDir === 'asc' ? 'Smallest first' : 'Largest first'}
      onClick={() => onSort(sortKey, sortDir === 'asc' ? 'desc' : 'asc')}
    >
      {sortDir === 'asc' ? <ArrowUp/> : <ArrowDown/>}
    </button>

    <div className="seg views" role="group" aria-label="View">
      <button
        type="button" data-on={view === 'cards' || undefined} aria-pressed={view === 'cards'}
        onClick={() => onView('cards')} title="One card per torrent, with artwork."
      ><Grid/>Cards</button>
      <button
        type="button" data-on={view === 'table' || undefined} aria-pressed={view === 'table'}
        onClick={() => onView('table')} title="A dense table, for a lot of torrents at once."
      ><ListIcon/>Table</button>
    </div>
  </div>
)
