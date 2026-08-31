import type { Torrent } from '../torrent/types'
import type { SortDir, SortKey } from '../torrent/list-view'

import { css } from '@emotion/react'
import { Clock } from 'react-feather'

import { NATURAL_DIR, SORT_LABEL, TEMPORARY_GONE_HINT, TEMPORARY_HINT } from '../torrent/list-view'
import { badgeRules } from './badge-style'
import { STATE_LABEL, relativeDay, speed } from './torrent-format'
import { getHumanReadableByteString } from '../utils/bytes'
import { hint } from '../components/hint'
import {
  BORDER, CONTROL_BG, EMPHASIS, FOCUS_RING, HOVER_WASH, SUNKEN_BG,
  SURFACE_BG, TEXT, TEXT_FAINT, TEXT_MUTED,
} from '../theme'

/**
 * The library as a table, for when there are more torrents than cards make sense of.
 *
 * A real `<table>` with real `<th scope="col">` headers, so a screen reader announces the column a
 * cell belongs to and `aria-sort` says which one the list is ordered by. A grid of divs would look
 * identical and tell somebody using one nothing at all.
 *
 * It deliberately carries FEWER affordances than the card view: no artwork, no spark graph, no
 * inline file list, no per-row action strip. Those are what the cards are for. Every row still opens
 * the same detail dock and the same options menu, which is where every action lives.
 */
const style = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;

  ${badgeRules}

  th, td {
    text-align: left;
    padding: 8px 10px;
    white-space: nowrap;
  }

  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    /* opaque: rows scroll underneath this */
    background: ${SURFACE_BG};
    border-bottom: 1px solid ${BORDER};
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${TEXT_MUTED};
    padding: 0;

    button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 5px;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      padding: 9px 10px;
      cursor: pointer;

      &:hover { color: ${TEXT}; }

      &:focus-visible { outline: none; box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }
    }

    /* the arrow is drawn from the sort state rather than from a hue, so it survives at any contrast */
    .arrow { opacity: 0.9; }
  }

  /* numbers right-aligned so their digits line up down the column, names left */
  th.num button { justify-content: flex-end; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: ${TEXT_MUTED}; }

  tbody tr {
    border-bottom: 1px solid ${BORDER};
    cursor: default;

    &:hover { background: ${HOVER_WASH}; }

    &[data-selected] { background: ${CONTROL_BG}; }
  }

  td.name {
    width: 100%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: ${TEXT};
  }

  .cell-name {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;

    span.title {
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  /* the same chip the card meta line uses, so one marker means one thing in both views */
  .temp {
    flex: none;
    display: inline-flex;
    align-items: center;
    color: ${TEXT_MUTED};
  }

  .bar {
    width: 64px;
    height: 4px;
    border-radius: 2px;
    background: ${SUNKEN_BG};
    overflow: hidden;

    .fill {
      height: 100%;
      border-radius: 2px;
      background: ${EMPHASIS};
    }
  }

  .pct {
    display: inline-block;
    min-width: 34px;
    text-align: right;
    color: ${TEXT_FAINT};
  }

  /* Dropped narrowest first, and the order is deliberate: a name and what it is doing are the two
     things that survive to the end. */
  @media (max-width: 1100px) { .c-added { display: none; } }
  @media (max-width: 940px) { .c-up { display: none; } }
  @media (max-width: 820px) { .c-peers { display: none; } }
  @media (max-width: 700px) { .c-size { display: none; } }
`

type Column = {
  key: SortKey | null
  label: string
  /** The class that lets a media query drop this column, absent for the two that never go. */
  cls?: string
  num?: boolean
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size', cls: 'c-size', num: true },
  { key: 'progress', label: 'Progress', cls: 'c-progress' },
  { key: null, label: 'State', cls: 'c-status' },
  { key: 'down', label: 'Down', cls: 'c-down', num: true },
  { key: 'up', label: 'Up', cls: 'c-up', num: true },
  { key: 'peers', label: 'Peers', cls: 'c-peers', num: true },
  { key: 'added', label: 'Added', cls: 'c-added', num: true },
]

export type TorrentTableProps = {
  torrents: readonly Torrent[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  selectedId: string | null
  onSelect: (t: Torrent) => void
  onOptions: (t: Torrent, at: { x: number, y: number } | null) => void
}

export const TorrentTable = (
  { torrents, sortKey, sortDir, onSort, selectedId, onSelect, onOptions }: TorrentTableProps,
) => (
  <table css={style} className="torrent-table">
    <thead>
      <tr>
        {COLUMNS.map((c) => {
          const sorted = c.key !== null && c.key === sortKey
          return (
            <th
              key={c.label}
              scope="col"
              className={[c.cls, c.num ? 'num' : ''].filter(Boolean).join(' ')}
              // only a sortable column claims a sort state; "no sort applied" is the honest answer
              // for one that cannot be sorted at all, and `none` would claim it could be
              aria-sort={c.key === null ? undefined : sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              {c.key === null
                ? <button type="button" disabled style={{ cursor: 'default' }}>{c.label}</button>
                : (
                  <button
                    type="button"
                    // clicking the column already sorted flips it, a different column starts at the
                    // direction that answers the question it was clicked to ask
                    onClick={() => onSort(c.key!, sorted ? (sortDir === 'asc' ? 'desc' : 'asc') : NATURAL_DIR[c.key!])}
                    {...hint(`Sort by ${SORT_LABEL[c.key]}`)}
                  >
                    {c.label}
                    {sorted && <span className="arrow" aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                )}
            </th>
          )
        })}
      </tr>
    </thead>
    <tbody>
      {torrents.map((t) => (
        <tr
          key={t.id}
          data-selected={t.id === selectedId || undefined}
          onClick={() => onSelect(t)}
          onContextMenu={(e) => { e.preventDefault(); onOptions(t, { x: e.clientX, y: e.clientY }) }}
        >
          <td className="name" {...hint(t.name)}>
            <div className="cell-name">
              {/*
                * A span rather than a button here, unlike the card view. A button per row would add
                * one tab stop in front of every row in a hundred row list, and by the time somebody
                * is in the table they have already met this marker on a card.
                */}
              {t.ephemeral === true && (
                <span
                  className="temp" role="img" aria-label="Temporary download"
                  {...hint(t.state === 'missing' ? TEMPORARY_GONE_HINT : TEMPORARY_HINT)}
                >
                  <Clock size={13} aria-hidden="true"/>
                </span>
              )}
              <span className="title">{t.name}</span>
            </div>
          </td>
          <td className="c-size num">{t.size > 0 ? getHumanReadableByteString(t.size) : '-'}</td>
          <td className="c-progress">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="bar"><div className="fill" style={{ width: `${Math.round(t.progress * 100)}%` }}/></div>
              <span className="pct">{Math.round(t.progress * 100)}%</span>
            </div>
          </td>
          <td className="c-status">
            <span className={'badge ' + t.state}>{STATE_LABEL[t.state]}</span>
          </td>
          <td className="c-down num">{t.down > 0 ? speed(t.down) : '-'}</td>
          <td className="c-up num">{t.up > 0 ? speed(t.up) : '-'}</td>
          <td className="c-peers num">{t.state === 'missing' ? '-' : t.peers}</td>
          <td className="c-added num">{relativeDay(t.addedAt)}</td>
        </tr>
      ))}
    </tbody>
  </table>
)
