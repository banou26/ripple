import type { DragEvent as ReactDragEvent } from 'react'
import type { IntlShape, MessageDescriptor } from 'react-intl'

import type { GroupIcon } from '../torrent/group-appearance'
import type { LibraryEntry } from '../torrent/group-rows'
import type { TorrentGroup } from '../torrent/groups'
import type { Torrent } from '../torrent/types'
import type { ExpandedGroups, SortDir, SortKey } from '../torrent/list-view'
import type { EngineTransport } from '../torrent/vpn-config'
import type { MenuPosition } from '../components/menu'
import type { DragPayload, DropIndicator } from './list-drag'
import type { Picked } from './bulk-selection'

import { css } from '@emotion/react'
import { ChevronRight, Clock, Ellipsis, Folder } from 'lucide-react'
import { defineMessage, useIntl } from 'react-intl'

import { DEFAULT_ICON } from '../torrent/group-appearance'
import { NATURAL_DIR, SORT_LABEL, TEMPORARY_HINT, reclaimable } from '../torrent/list-view'
import { noPeersLine } from '../torrent/no-peers'
import { GroupMiniIcon } from '../components/group-icon'
import { badgeRules, stateHues } from './badge-style'
import { pickable } from './bulk-selection'
import { STATE_LABEL, chosenBytes, relativeDay, speed, withWhole } from './torrent-format'
import { getHumanReadableByteString, writePercent } from '../utils/bytes'
import { hint, typedHint } from '../components/hint'
import { RowCheck, pickedRowStyle, rowClicks } from '../components/bulk-actions'
import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, EMPHASIS, FOCUS_RING, GROUP_COUNT_BG, GROUP_TEXT, HOVER_WASH, STATE_DOWN, STATE_UP, SUNKEN_BG,
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
 * the same detail dock and the same options menu, which is where every action lives: a right-click,
 * or the row's own options button, which is the only way to it from a keyboard or an iPhone (Safari
 * sends no contextmenu on a long press).
 */
const style = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;

  ${stateHues}
  ${badgeRules}

  th, td {
    text-align: start;
    padding: 8px 10px;
    white-space: nowrap;
  }

  /* the box column's header is a td, having no name, and sticks with the rest */
  thead th, thead td {
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

  /* numbers at the cell's end so their digits line up down the column, names at its start */
  th.num button { justify-content: flex-end; }
  td.num { text-align: end; font-variant-numeric: tabular-nums; color: ${TEXT_MUTED}; }

  /* only while bytes move, as on the cards */
  td.c-down.live { color: ${STATE_DOWN}; }
  td.c-up.live { color: ${STATE_UP}; }

  tbody tr {
    scroll-margin-top: 38px;
    border-bottom: 1px solid ${BORDER};
    cursor: default;

    &:hover { background: ${HOVER_WASH}; }

    &[data-selected] { background: ${CONTROL_BG}; }

    /* the state's edge, as on the cards; a ticked row's own edge takes its place */
    td:first-of-type { box-shadow: inset 4px 0 0 var(--edge, transparent); }

    &[data-picked] {
      ${pickedRowStyle}

      td:first-of-type { box-shadow: none; }
    }

    &[data-dragging='true'] { opacity: 0.55; }
    &[data-drop='before'] td { box-shadow: inset 0 2px 0 0 ${FOCUS_RING}; }
    &[data-drop='after'] td { box-shadow: inset 0 -2px 0 0 ${FOCUS_RING}; }
    &[data-drop='into'] {
      background: ${CONTROL_BG};
      td { box-shadow: inset 0 1px 0 0 ${FOCUS_RING}, inset 0 -1px 0 0 ${FOCUS_RING}; }
    }
  }

  tr.group-row {
    cursor: pointer;

    .cell-name span.title {
      font-weight: 600;
    }

    td.check button.expand {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: none;
      color: ${TEXT_MUTED};
      cursor: pointer;

      &:hover { color: ${TEXT}; }
      &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }

      svg { flex: none; transition: transform 120ms ease; }
    }

    &:not([data-expanded='true']):dir(rtl) td.check button.expand svg {
      transform: rotate(180deg);
    }

    &[data-expanded='true'] td.check button.expand svg {
      transform: rotate(90deg);
    }

    .group-count {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 7px;
      border-radius: 999px;
      background: ${GROUP_COUNT_BG};
      color: ${GROUP_TEXT};
      font-size: 0.72rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;

      svg { flex: none; }
    }
  }

  tr.group-child .cell-name {
    position: relative;
    padding-inline-start: 22px;

    &::before {
      content: '';
      position: absolute;
      inset-inline-start: 8px;
      top: -9px;
      bottom: -9px;
      width: 2px;
      background: ${BORDER_STRONG};
    }
  }

  /* The box's label is its hit area, and its ::before spreads that over the whole cell, or a click just above or
     below the box would open the details instead. Before the box and the box positioned too, so the box paints on
     top of it; not in the header's cell, which stays sticky. */
  td.check {
    padding: 0;

    .row-check { width: 32px; height: 32px; }

    .row-check::before { content: ''; position: absolute; inset: 0; }

    input { position: relative; }
  }

  tbody td.check { position: relative; }

  td.more {
    width: 30px;
    padding: 0;

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: none;
      color: ${TEXT_MUTED};
      cursor: pointer;

      &:hover { color: ${TEXT}; background: ${CONTROL_HOVER_BG}; }

      &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }
    }
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
      min-width: 0;
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
    background: var(--tint, ${SUNKEN_BG});
    overflow: hidden;

    .fill {
      height: 100%;
      border-radius: 2px;
      background: var(--hue, ${EMPHASIS});
    }
  }

  .pct {
    display: inline-block;
    min-width: 34px;
    text-align: end;
    color: var(--hue, ${TEXT_FAINT});
  }

  /* Dropped narrowest first, and the order is deliberate: a name and what it is doing are the two
     things that survive to the end. */
  @media (max-width: 1100px) { .c-added { display: none; } }
  @media (max-width: 940px) { .c-up { display: none; } }
  @media (max-width: 820px) { .c-peers { display: none; } }
  @media (max-width: 700px) { .c-size { display: none; } }
  /* On a phone a state takes a second line only where one line would leave the name under 84 px: the window less
     the list's padding (32), the box column (32), the options column (30), that name and the state cell's padding
     (6, the options button's own room standing for the rest), and with Progress showing, its column (100, as wide as
     Italian's AVANZAMENTO in DejaVu Sans). Without it Brazilian Portuguese's TENTANDO NOVAMENTE left a name 54 px at
     320 px, and French 49 px at 401 px; a floor on the column instead wrapped EN PAUSE at 390 px, where nothing has to.
     One word wider than the room breaks inside itself rather than widen its badge into the name's room, in any font
     (French TÉLÉCHARGEMENT at 320 px), and from 401 px also where Progress is narrower than the 100 px allowed. */
  @media (max-width: 560px) {
    .c-down, .bar { display: none; }
    /* a finger's height, and the name's padding beside the box, for a finger's width without taking the name's room */
    tbody td.check { height: 40px; }
    td.check .row-check::before { inset-inline-end: -8px; }
    td.c-status { padding-inline: 4px 2px; }
    td.c-status .badge { width: max-content; max-width: calc(100vw - 284px); white-space: normal; overflow-wrap: anywhere; }
    td.c-status .badge::before { flex: none; }
  }
  /* with Progress, French left a name 47 px at 360 px and ran past a 320 px window */
  @media (max-width: 400px) {
    .c-progress { display: none; }
    td.c-status .badge { max-width: calc(100vw - 184px); }
  }
`

type Column = {
  key: SortKey | null
  label: MessageDescriptor
  /** The class that lets a media query drop this column, absent for the two that never go. */
  cls?: string
  num?: boolean
}

const COLUMNS: Column[] = [
  { key: 'name', label: SORT_LABEL.name },
  { key: 'size', label: SORT_LABEL.size, cls: 'c-size', num: true },
  { key: 'progress', label: SORT_LABEL.progress, cls: 'c-progress' },
  { key: null, label: defineMessage({ id: 'State', defaultMessage: 'State' }), cls: 'c-status' },
  { key: 'down', label: defineMessage({ id: 'Down', defaultMessage: 'Down' }), cls: 'c-down', num: true },
  { key: 'up', label: defineMessage({ id: 'Up', defaultMessage: 'Up' }), cls: 'c-up', num: true },
  { key: 'peers', label: SORT_LABEL.peers, cls: 'c-peers', num: true },
  { key: 'added', label: defineMessage({ id: 'Added', defaultMessage: 'Added' }), cls: 'c-added', num: true },
]

const ARROW = { asc: '↑', desc: '↓' }
const UNKNOWN = '-'

/** The size column: the chosen files' with the whole torrent's in brackets where files are left out. */
const sizeOf = (intl: IntlShape, t: Torrent): string => {
  const chosen = chosenBytes(t)
  if (chosen) return withWhole(intl, getHumanReadableByteString(chosen.size), getHumanReadableByteString(t.size))
  return t.size > 0 ? getHumanReadableByteString(t.size) : UNKNOWN
}

export type TorrentTableProps = {
  torrents?: readonly Torrent[]
  entries?: readonly LibraryEntry[]
  expandedGroups?: ExpandedGroups
  groupIcons?: ReadonlyMap<string, GroupIcon>
  onToggleExpand?: (groupId: string) => void
  onGroupOptions?: (group: TorrentGroup, at: MenuPosition | null) => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  selectedId: string | null
  onSelect: (t: Torrent) => void
  onOptions: (t: Torrent, at: MenuPosition | null) => void
  /** The ticked rows, by info hash, which are not the one row the dock shows. */
  picked: Picked
  /** Ticks or unticks `t`, or with `shift` the run from the box clicked before, and ignores a row that cannot be ticked. */
  onPick: (t: Torrent, shift: boolean) => void
  /** What the engine reaches its peers through: with the VPN off a download that found nobody says so on its state. */
  transport?: EngineTransport | null
  draggingKey?: string | null
  dropIndicator?: DropIndicator
  onRowDragStart?: (payload: DragPayload, dragKey: string, e: ReactDragEvent) => void
  onRowDragEnd?: () => void
  onRowDragOver?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  onRowDragLeave?: (targetKey: string) => void
  onRowDrop?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
}

export const TorrentTable = ({
  torrents,
  entries,
  expandedGroups,
  groupIcons,
  onToggleExpand,
  onGroupOptions,
  sortKey,
  sortDir,
  onSort,
  selectedId,
  onSelect,
  onOptions,
  picked,
  onPick,
  transport,
  draggingKey,
  dropIndicator,
  onRowDragStart,
  onRowDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
}: TorrentTableProps) => {
  const intl = useIntl()
  const rows: readonly LibraryEntry[] = entries ?? (torrents ?? []).map((t) => ({ kind: 'torrent', key: `t:${t.id}`, torrent: t }))

  const dragPropsFor = (dragKey: string, payload: DragPayload | null, allowInto: boolean) => (
    onRowDragStart
      ? {
        draggable: payload !== null,
        onDragStart: payload ? (e: ReactDragEvent) => onRowDragStart(payload, dragKey, e) : undefined,
        onDragEnd: onRowDragEnd,
        onDragOver: (e: ReactDragEvent) => onRowDragOver?.(dragKey, allowInto, e),
        onDragLeave: () => onRowDragLeave?.(dragKey),
        onDrop: (e: ReactDragEvent) => onRowDrop?.(dragKey, allowInto, e),
        'data-dragging': draggingKey === dragKey || undefined,
        'data-drop': dropIndicator?.targetKey === dragKey ? dropIndicator.place : undefined,
      }
      : {}
  )

  const renderTorrentRow = (t: Torrent, key: string, dragKey: string, dragPayload: DragPayload | null, child = false) => (
    <tr
      key={key}
      className={child ? 'group-child' : undefined}
      data-state={t.state}
      data-selected={t.id === selectedId || undefined}
      data-picked={(pickable(t) && picked.has(t.infoHash)) || undefined}
      {...dragPropsFor(dragKey, dragPayload, !child && !!t.infoHash)}
      {...rowClicks((shift) => onPick(t, shift), () => onSelect(t))}
      onContextMenu={(e) => { e.preventDefault(); onOptions(t, { x: e.clientX, y: e.clientY }) }}
    >
      <td className="check">
        {pickable(t) && <RowCheck name={t.name} checked={picked.has(t.infoHash)} onChange={(shift) => onPick(t, shift)}/>}
      </td>
      <td className="name" {...typedHint(t.name)}>
        <div className="cell-name">
          {/*
            * A span rather than a button here, unlike the card view. A button per row would add
            * one tab stop in front of every row in a hundred row list, and by the time somebody
            * is in the table they have already met this marker on a card.
            */}
          {t.ephemeral === true && (
            <span
              className="temp" role="img" aria-label={intl.formatMessage({ id: 'Temporary download', defaultMessage: 'Temporary download' })}
              {...hint(reclaimable(t) ? intl.formatMessage(TEMPORARY_HINT) : null)}
            >
              <Clock size={13} aria-hidden="true"/>
            </span>
          )}
          <span className="title" dir="auto">{t.name}</span>
        </div>
      </td>
      <td className="c-size num">{sizeOf(intl, t)}</td>
      <td className="c-progress">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="bar"><div className="fill" style={{ width: `${Math.round(t.progress * 100)}%` }}/></div>
          {/* rounded as the bar is: Intl reads 0.285 as written and shows 29%, where the bar's 28.499... is 28% */}
          <span className="pct">{writePercent(Math.round(t.progress * 100) / 100)}</span>
        </div>
      </td>
      <td className="c-status">
        {/* the cards have a line for it, and a row here has its state alone: with the VPN off nothing else tells
            a download nobody serves from one that has just begun */}
        <span className={'badge ' + t.state} {...hint(t.noPeers && transport === 'direct' ? noPeersLine(transport) : null)}>
          {intl.formatMessage(STATE_LABEL[t.state])}
        </span>
      </td>
      <td className={'c-down num' + (t.down > 0 ? ' live' : '')}>{t.down > 0 ? speed(t.down) : UNKNOWN}</td>
      <td className={'c-up num' + (t.up > 0 ? ' live' : '')}>{t.up > 0 ? speed(t.up) : UNKNOWN}</td>
      <td className="c-peers num">{t.state === 'missing' ? UNKNOWN : t.peers}</td>
      <td className="c-added num">{relativeDay(t.addedAt)}</td>
      <td className="more">
        <button
          type="button"
          className="more"
          aria-haspopup="dialog"
          aria-label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: t.name })}
          {...hint(intl.formatMessage({ id: 'Options', defaultMessage: 'Options' }))}
          onClick={(e) => { e.stopPropagation(); onOptions(t, null) }}
        >
          <Ellipsis size={16} aria-hidden="true"/>
        </button>
      </td>
    </tr>
  )

  return <table css={style} className="torrent-table">
    <thead>
      <tr>
        <td className="check"/>
        {COLUMNS.map((c) => {
          const { key } = c
          const sorted = key !== null && key === sortKey
          const label = intl.formatMessage(c.label)
          return (
            <th
              key={c.label.id}
              scope="col"
              className={[c.cls, c.num ? 'num' : ''].filter(Boolean).join(' ')}
              // only a sortable column claims a sort state; "no sort applied" is the honest answer
              // for one that cannot be sorted at all, and `none` would claim it could be
              aria-sort={key === null ? undefined : sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              {key === null
                ? <button type="button" disabled style={{ cursor: 'default' }}>{label}</button>
                : (
                  <button
                    type="button"
                    // clicking the column already sorted flips it, a different column starts at the
                    // direction that answers the question it was clicked to ask
                    onClick={() => onSort(key, sorted ? (sortDir === 'asc' ? 'desc' : 'asc') : NATURAL_DIR[key])}
                    {...hint(intl.formatMessage({ id: 'Sort by {label}', defaultMessage: 'Sort by {label}' }, { label: intl.formatMessage(SORT_LABEL[key]) }))}
                  >
                    {label}
                    {sorted && <span className="arrow" aria-hidden="true">{ARROW[sortDir]}</span>}
                  </button>
                )}
            </th>
          )
        })}
        <td className="more"/>
      </tr>
    </thead>
    <tbody>
      {rows.flatMap((entry) => {
        if (entry.kind === 'torrent') {
          return [renderTorrentRow(entry.torrent, entry.torrent.id, entry.key, entry.torrent.infoHash ? { kind: 'top', key: entry.key } : null)]
        }
        const { group, summary } = entry
        const expanded = !!expandedGroups?.has(group.id)
        const icon = groupIcons?.get(group.id) ?? DEFAULT_ICON
        return [
          <tr
            key={entry.key}
            className="group-row"
            data-state={summary.state}
            data-expanded={expanded || undefined}
            {...dragPropsFor(entry.key, { kind: 'top', key: entry.key }, true)}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              onToggleExpand?.(group.id)
            }}
            onContextMenu={(e) => {
              if (e.shiftKey || e.ctrlKey) return
              e.preventDefault()
              onGroupOptions?.(group, { x: e.clientX, y: e.clientY })
            }}
          >
            <td className="check">
              <button
                type="button"
                className="expand"
                aria-expanded={expanded}
                aria-label={expanded
                  ? intl.formatMessage({ id: 'Collapse {name}', defaultMessage: 'Collapse {name}' }, { name: group.name })
                  : intl.formatMessage({ id: 'Expand {name}', defaultMessage: 'Expand {name}' }, { name: group.name })}
                onClick={(e) => { e.stopPropagation(); onToggleExpand?.(group.id) }}
              >
                <ChevronRight size={14} aria-hidden="true"/>
              </button>
            </td>
            <td className="name" {...typedHint(group.name)}>
              <div className="cell-name">
                <GroupMiniIcon groupId={group.id} icon={icon} previewHashes={summary.previewHashes}/>
                <span className="title" dir="auto">{group.name}</span>
                <span className="group-count">
                  <Folder size={11} strokeWidth={2} aria-hidden="true"/>
                  {summary.count}
                </span>
              </div>
            </td>
            <td className="c-size num">{summary.size > 0 ? getHumanReadableByteString(summary.size) : UNKNOWN}</td>
            <td className="c-progress">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="bar"><div className="fill" style={{ width: `${Math.round(summary.progress * 100)}%` }}/></div>
                <span className="pct">{writePercent(Math.round(summary.progress * 100) / 100)}</span>
              </div>
            </td>
            <td className="c-status">
              <span className={'badge ' + summary.state}>{intl.formatMessage(STATE_LABEL[summary.state])}</span>
            </td>
            <td className={'c-down num' + (summary.down > 0 ? ' live' : '')}>{summary.down > 0 ? speed(summary.down) : UNKNOWN}</td>
            <td className={'c-up num' + (summary.up > 0 ? ' live' : '')}>{summary.up > 0 ? speed(summary.up) : UNKNOWN}</td>
            <td className="c-peers num">{summary.state === 'missing' ? UNKNOWN : summary.peers}</td>
            <td className="c-added num">{relativeDay(summary.addedAt)}</td>
            <td className="more">
              <button
                type="button"
                className="more"
                aria-haspopup="dialog"
                aria-label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: group.name })}
                {...hint(intl.formatMessage({ id: 'Options', defaultMessage: 'Options' }))}
                onClick={(e) => { e.stopPropagation(); onGroupOptions?.(group, null) }}
              >
                <Ellipsis size={16} aria-hidden="true"/>
              </button>
            </td>
          </tr>,
          ...(expanded
            ? summary.members.map((m) => renderTorrentRow(
              m,
              `group:${group.id}:${m.id}`,
              `child:${group.id}:${m.infoHash ?? m.id}`,
              m.infoHash ? { kind: 'member', groupId: group.id, infoHash: m.infoHash } : null,
              true,
            ))
            : []),
        ]
      })}
    </tbody>
  </table>
}
