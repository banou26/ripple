import type { ListFilter, SortDir, SortKey, ViewMode } from '../torrent/list-view'

import { css } from '@emotion/react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, LayoutGrid, Layers, List as ListIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import { FILTER_LABEL, NATURAL_DIR, SORT_LABEL, offeredFilters } from '../torrent/list-view'
import { checkStyle } from './bulk-actions'
import { hint } from './hint'
import { MenuSurface } from './menu'
import {
  BORDER, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  FOCUS_RING, SUNKEN_BG, TEXT, TEXT_MUTED,
} from '../theme'

/* the box's 40 px hit area pulled into the margin, so the row keeps its height */
const pickAllStyle = css`
  margin: -5px -10px -5px -8px;

  input:disabled { cursor: default; }
`

/** The box that ticks every row shown, or none: mixed while only some are. */
const PickAll = ({ picked, canPick, onPickAll }: Pick<ListToolbarProps, 'picked' | 'canPick' | 'onPickAll'>) => {
  const intl = useIntl()
  const box = useRef<HTMLInputElement>(null)
  // a property with no attribute, so React cannot set it
  useEffect(() => { if (box.current) box.current.indeterminate = picked === 'some' }, [picked])
  const selectAll = intl.formatMessage({ id: 'Select all', defaultMessage: 'Select all' })
  return (
    <label css={[checkStyle, pickAllStyle]} className="pick-all" {...hint(selectAll)}>
      <input
        ref={box}
        type="checkbox"
        checked={picked === 'all'}
        disabled={!canPick}
        onChange={onPickAll}
        aria-label={selectAll}
      />
    </label>
  )
}

const segStyle = css`
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
`

/** Cards or Table. Each button keeps its word in a span, which a narrow toolbar hides, and its name either way. */
const ViewSwitch = ({ view, onView }: Pick<ListToolbarProps, 'view' | 'onView'>) => {
  const intl = useIntl()
  const cards = intl.formatMessage({ id: 'Cards', defaultMessage: 'Cards' })
  const table = intl.formatMessage({ id: 'Table', defaultMessage: 'Table' })
  return (
    <div css={segStyle} className="seg views" role="group" aria-label={intl.formatMessage({ id: 'View', defaultMessage: 'View' })}>
      <button
        type="button" data-on={view === 'cards' || undefined} aria-pressed={view === 'cards'}
        aria-label={cards} onClick={() => onView('cards')}
      ><LayoutGrid/><span>{cards}</span></button>
      <button
        type="button" data-on={view === 'table' || undefined} aria-pressed={view === 'table'}
        aria-label={table} onClick={() => onView('table')}
      ><ListIcon/><span>{table}</span></button>
    </div>
  )
}

/**
 * What is shown, in what order, and in which shape: the box, a chip for the filter, one for the group and one for the
 * sort, each opening its list, and the views at the far end. One row at every width.
 *
 * Self contained, because it is mounted by home and tested on its own. Everything here reports state
 * upward and holds none but which menu is open: the preferences are persisted by the page, and a
 * control that remembered its own answer would eventually disagree with the list it claims to describe,
 * which is the rule torrent-options.ts already states for itself.
 */
const style = css`
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 16px 0;

  .views { margin-left: auto; flex: none; }

  /* a chip narrows before the row would wrap, its word ending in an ellipsis */
  .chip {
    flex: 0 1 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px 0 10px;
    border: 1px solid ${BORDER};
    border-radius: 999px;
    background: ${CONTROL_BG};
    color: ${TEXT};
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;

    svg { flex: none; width: 14px; height: 14px; }

    &:hover, &[aria-expanded='true'] { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }

    .value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { flex: none; color: ${TEXT_MUTED}; font-variant-numeric: tabular-nums; }
    .chev { color: ${TEXT_MUTED}; }
  }

  /* the sort key gives way first, down to its icon and its chevron, then the group's name, so the filter (which rows
     are listed) is the last word cut. flex-shrink is weighted by size and a later chip still takes its share, which has
     to stay under a layout unit (1/64 px) or its ellipsis is drawn: at 1000 French's longest filter lost 0.13 px of it
     at 390 px. A name is as long as somebody typed, so its word stops at 15em, which keeps it out of the weights too */
  .chip.sort {
    flex-shrink: 10000000000;
    min-width: 60px;
  }

  .chip.group {
    flex-shrink: 100000;
    min-width: 60px;

    .value { max-width: 15em; }
  }

  @media (max-width: 560px) {
    .views span { display: none; }
    .views button { padding: 5px 9px; }
  }

  /* at their least, the three chips, the box and the views take 307 px with 8 px gaps, past the 288 px a 320 px window
     leaves; at 390 px these 24 px are what a filter such as Temporary has before it is cut */
  @media (max-width: 400px) {
    gap: 4px;

    .views button { padding: 5px 7px; }
  }
`

const choicesStyle = css`
  button .count {
    margin-left: 16px;
    color: ${TEXT_MUTED};
    font-variant-numeric: tabular-nums;
  }

  button .tick svg {
    width: 14px;
    height: 14px;
    vertical-align: -2px;
  }
`

/** the chosen row's mark, the one menu.tsx draws for a radio */
const DOT = '●'

const DirIcon = ({ dir }: { dir: SortDir }) => (dir === 'asc' ? <ArrowUpNarrowWide aria-hidden="true"/> : <ArrowDownWideNarrow aria-hidden="true"/>)

/**
 * `name` is the row's accessible name when its words and its count would otherwise be read run together. `typed` marks
 * a label somebody typed, a group's name, which is isolated so a right-to-left mark in it turns nothing around it.
 */
type Choice = { id: string, label: string, name?: string, count?: number, on: boolean, title?: string, arrow?: SortDir, typed?: boolean, pick: () => void }

/** A row that does something rather than choose one. */
type Action = { id: string, label: string, danger?: boolean, run: () => void }

const Choices = ({ label, typed, choices = [], actions = [], onChose }: {
  label: string
  typed?: boolean
  choices?: Choice[]
  actions?: Action[]
  onChose: () => void
}) => (
  <div css={choicesStyle} className="group" role="group" aria-label={label}>
    <label dir={typed ? 'auto' : undefined}>{label}</label>
    {choices.map((choice) => (
      <button
        key={choice.id}
        type="button"
        role="menuitemradio"
        aria-checked={choice.on}
        aria-label={choice.name}
        // the menu moves focus itself, so only the row it lands on is in the tab order
        tabIndex={-1}
        title={choice.title}
        onClick={() => { choice.pick(); onChose() }}
      >
        <span className="tick" aria-hidden="true">{choice.on && (choice.arrow ? <DirIcon dir={choice.arrow}/> : DOT)}</span>
        <span className="text" dir={choice.typed ? 'auto' : undefined}>{choice.label}</span>
        {choice.count !== undefined && <span className="count">{choice.count}</span>}
      </button>
    ))}
    {actions.map((action) => (
      <button
        key={action.id}
        type="button"
        role="menuitem"
        className={action.danger ? 'danger' : undefined}
        tabIndex={-1}
        onClick={() => { action.run(); onChose() }}
      >
        <span className="tick" aria-hidden="true"/>
        <span className="text">{action.label}</span>
      </button>
    ))}
  </div>
)

/** A chip's menu: open or not, and the chip it hangs from. */
const useMenu = () => {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return {
    open,
    anchor,
    close: () => setOpen(false),
    trigger: { ref: anchor, 'aria-haspopup': 'menu' as const, 'aria-expanded': open, onClick: () => setOpen((was) => !was) },
  }
}

/** The Group chip: which group the list shows, and what can be done to it. */
export type GroupChoice = {
  /** Each group, in the order offered, with how many rows it shows under the filter. */
  list: { id: string, name: string, count: number }[]
  /** The group shown, or null for every torrent. */
  shown: string | null
  /** How many rows every torrent shows under the filter. */
  all: number
  onShow: (id: string | null) => void
  onNew: () => void
  /** Fetches the shown group's torrents not on this device; absent while it has none that can be fetched. */
  onDownloadAll?: () => void
  onRename: () => void
  onDelete: () => void
}

export type ListToolbarProps = {
  filter: ListFilter
  onFilter: (filter: ListFilter) => void
  group: GroupChoice
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
  { filter, onFilter, group, sortKey, sortDir, onSort, view, onView, counts, picked, canPick, onPickAll }: ListToolbarProps,
) => {
  const intl = useIntl()
  const showMenu = useMenu()
  const groupMenu = useMenu()
  const sortMenu = useMenu()
  const show = intl.formatMessage({ id: 'Show#verb', defaultMessage: 'Show', description: 'verb' })
  const groupWord = intl.formatMessage({ id: 'Group', defaultMessage: 'Group' })
  const sort = intl.formatMessage({ id: 'Sort', defaultMessage: 'Sort' })
  const counted = (label: string, count: number) =>
    intl.formatMessage({ id: '{filter} ({count})', defaultMessage: '{filter} ({count})' }, { filter: label, count })
  const shown = (f: ListFilter) => counted(intl.formatMessage(FILTER_LABEL[f]), counts[f])
  const everything = intl.formatMessage({ id: 'All torrents', defaultMessage: 'All torrents' })
  const shownGroup = group.list.find((g) => g.id === group.shown)
  const groups: Choice[] = [
    { id: '', label: everything, name: counted(everything, group.all), count: group.all, on: !shownGroup, pick: () => group.onShow(null) },
    ...group.list.map((g) => ({
      id: g.id, label: g.name, name: counted(g.name, g.count), count: g.count, on: g === shownGroup, typed: true, pick: () => group.onShow(g.id),
    })),
  ]
  const groupActions: Action[] = [
    ...group.onDownloadAll ? [{ id: 'download-all', label: intl.formatMessage({ id: 'Download all', defaultMessage: 'Download all' }), run: group.onDownloadAll }] : [],
    { id: 'rename', label: intl.formatMessage({ id: 'Rename...', defaultMessage: 'Rename...' }), run: group.onRename },
    { id: 'delete', label: intl.formatMessage({ id: 'Delete group', defaultMessage: 'Delete group' }), danger: true, run: group.onDelete },
  ]
  const filters: Choice[] = offeredFilters(counts, filter).map((f) => ({
    id: f,
    label: intl.formatMessage(FILTER_LABEL[f]),
    name: shown(f),
    count: counts[f],
    on: f === filter,
    pick: () => onFilter(f),
  }))
  const flip = sortDir === 'asc'
    ? intl.formatMessage({ id: 'Sorted ascending, click for descending', defaultMessage: 'Sorted ascending, click for descending' })
    : intl.formatMessage({ id: 'Sorted descending, click for ascending', defaultMessage: 'Sorted descending, click for ascending' })
  // the key already sorted by flips its direction; another starts in the direction that answers the question somebody
  // had when they picked it: newest, biggest, fastest, soonest
  const sorts: Choice[] = (Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({
    id: key,
    label: intl.formatMessage(SORT_LABEL[key]),
    on: key === sortKey,
    arrow: sortDir,
    title: key === sortKey ? flip : undefined,
    pick: () => onSort(key, key !== sortKey ? NATURAL_DIR[key] : sortDir === 'asc' ? 'desc' : 'asc'),
  }))
  return (
    <div css={style} className="list-toolbar">
      <PickAll picked={picked} canPick={canPick} onPickAll={onPickAll}/>
      <button
        type="button" className="chip show" {...showMenu.trigger}
        aria-label={intl.formatMessage({ id: 'Show: {filter}', defaultMessage: 'Show: {filter}' }, { filter: shown(filter) })}
      >
        <span className="value">{intl.formatMessage(FILTER_LABEL[filter])}</span>
        <span className="count">{counts[filter]}</span>
        <ChevronDown className="chev" aria-hidden="true"/>
      </button>
      <button
        type="button" className="chip group" {...groupMenu.trigger}
        aria-label={intl.formatMessage({ id: 'Group: {group}', defaultMessage: 'Group: {group}' }, {
          group: shownGroup ? counted(shownGroup.name, shownGroup.count) : counted(everything, group.all),
        })}
      >
        <Layers aria-hidden="true"/>
        <span className="value" dir={shownGroup ? 'auto' : undefined}>{shownGroup ? shownGroup.name : groupWord}</span>
        <ChevronDown className="chev" aria-hidden="true"/>
      </button>
      <button
        type="button" className="chip sort" {...sortMenu.trigger}
        aria-label={sortDir === 'asc'
          ? intl.formatMessage({ id: 'Sort by {label}, ascending', defaultMessage: 'Sort by {label}, ascending' }, { label: intl.formatMessage(SORT_LABEL[sortKey]) })
          : intl.formatMessage({ id: 'Sort by {label}, descending', defaultMessage: 'Sort by {label}, descending' }, { label: intl.formatMessage(SORT_LABEL[sortKey]) })}
        {...hint(sortDir === 'asc'
          ? intl.formatMessage({ id: 'Smallest first', defaultMessage: 'Smallest first' })
          : intl.formatMessage({ id: 'Largest first', defaultMessage: 'Largest first' }))}
      >
        <DirIcon dir={sortDir}/>
        <span className="value">{intl.formatMessage(SORT_LABEL[sortKey])}</span>
        <ChevronDown className="chev" aria-hidden="true"/>
      </button>
      <ViewSwitch view={view} onView={onView}/>
      {showMenu.open && (
        <MenuSurface placement={{ kind: 'under', of: showMenu.anchor, align: 'start' }} label={show} onClose={showMenu.close}>
          <Choices label={show} choices={filters} onChose={showMenu.close}/>
        </MenuSurface>
      )}
      {groupMenu.open && (
        <MenuSurface placement={{ kind: 'under', of: groupMenu.anchor, align: 'start' }} label={groupWord} onClose={groupMenu.close}>
          <Choices
            label={groupWord}
            choices={groups}
            actions={[{ id: 'new', label: intl.formatMessage({ id: 'New group...', defaultMessage: 'New group...' }), run: group.onNew }]}
            onChose={groupMenu.close}
          />
          {shownGroup && <Choices label={shownGroup.name} typed actions={groupActions} onChose={groupMenu.close}/>}
        </MenuSurface>
      )}
      {sortMenu.open && (
        <MenuSurface placement={{ kind: 'under', of: sortMenu.anchor, align: 'start' }} label={sort} onClose={sortMenu.close}>
          <Choices label={sort} choices={sorts} onChose={sortMenu.close}/>
        </MenuSurface>
      )}
    </div>
  )
}
