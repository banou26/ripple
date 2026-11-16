import type { ListToolbarProps } from './list-toolbar'
import type { OptionGroup } from '../torrent/torrent-options'
import type { ListFilter, SortDir, SortKey } from '../torrent/list-view'

import { css } from '@emotion/react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, SlidersHorizontal } from 'lucide-react'
import type { CSSProperties } from 'react'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'

import { DEFAULT_SORT, FILTER_LABEL, NATURAL_DIR, SORT_LABEL, offeredFilters } from '../torrent/list-view'
import { pickedRowStyle } from './bulk-actions'
import { hint } from './hint'
import { PickAll, ViewSwitch } from './list-toolbar'
import { MenuSurface } from './menu'
import { TorrentOptionsDialog } from './torrent-options-dialog'
import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, EMPHASIS, FOCUS_RING, HOVER_WASH, PAGE_BG, TEXT, TEXT_MUTED,
} from '../theme'

/**
 * Prototype (RIPPLE-130): three one row toolbars over the library, drawn in place of ListToolbar by `?toolbar=a|b|c`.
 * Same props and the same contract: everything is reported upward and nothing is held but which menu is open.
 *
 * a: a Show chip and a Sort chip, each opening its list. b: one icon button opening both lists together in the
 * options dialog's surface.
 * c: every offered filter as a chip in a strip that scrolls sideways, the chosen one drawn as a ticked row is, and an
 * icon button for Sort.
 */
export type CompactDesign = 'a' | 'b' | 'c'

const style = css`
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 16px 0;

  .views { margin-left: auto; flex: none; }

  .chip, .square {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT};
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;

    svg { flex: none; width: 14px; height: 14px; }

    &:hover, &[aria-expanded='true'] { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }

    &:focus-visible { outline: none; box-shadow: 0 0 0 2px ${FOCUS_RING}; }
  }

  /* a chip narrows before the row would wrap, its value ending in an ellipsis */
  .chip {
    flex: 0 1 auto;
    min-width: 0;
    padding: 0 8px 0 10px;
    border-radius: 999px;

    .value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { flex: none; color: ${TEXT_MUTED}; font-variant-numeric: tabular-nums; }
    .chev { color: ${TEXT_MUTED}; }
  }

  /* the sort key gives way first, down to its icon, so the filter (which rows are listed) is the last word cut;
     flex-shrink is weighted by size, hence a factor far above any ratio of the two chips' widths */
  .chip.sort {
    flex-shrink: 1000;
    min-width: 32px;
  }

  .square {
    position: relative;
    justify-content: center;
    width: 30px;
    padding: 0;
    border-radius: 6px;
  }

  /* on the button's corner, outside the icon, ringed in the page's colour so it reads as a badge */
  .dot {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${EMPHASIS};
    box-shadow: 0 0 0 2px ${PAGE_BG};
  }

  .strip {
    flex: 0 1 auto;
    min-width: 0;
    position: relative;
    display: flex;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }

    /* an end with chips past it fades out, so a strip cut between two chips still reads as one that scrolls */
    mask-image: linear-gradient(to right, transparent, #000 var(--fade-start), #000 calc(100% - var(--fade-end)), transparent);

    button {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 10px;
      border: none;
      border-radius: 6px;
      background: none;
      color: ${TEXT_MUTED};
      font: inherit;
      font-size: 0.8rem;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;

      .count { font-variant-numeric: tabular-nums; opacity: 0.75; }

      &:hover { color: ${TEXT}; background-color: ${HOVER_WASH}; }

      /* inset, since the strip scrolls and would clip a ring drawn outside the chip */
      &:focus-visible { outline: none; box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }

      &[aria-pressed='true'] {
        color: ${TEXT};
        ${pickedRowStyle};
      }
    }
  }

  @media (max-width: 560px) {
    .views span { display: none; }
    .views button { padding: 5px 9px; }
    .chip .chev { display: none; }
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

/** how wide the strip's edge fades, in px */
const FADE = 28

/** `label` makes the icon an image with that name, where it is the only thing saying the direction. */
const DirIcon = ({ dir, label }: { dir: SortDir, label?: string }) => {
  const Icon = dir === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow
  return label ? <Icon role="img" aria-label={label}/> : <Icon aria-hidden="true"/>
}

/** `name` is the row's accessible name when its words and its count would otherwise be read run together. */
type Choice = { id: string, label: string, name?: string, count?: number, on: boolean, title?: string, arrow?: SortDir, pick: () => void }

const Choices = ({ label, choices, onChose }: { label: string, choices: Choice[], onChose: () => void }) => (
  <div className="group" role="group" aria-label={label}>
    <label>{label}</label>
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
        <span className="text">{choice.label}</span>
        {choice.count !== undefined && <span className="count">{choice.count}</span>}
      </button>
    ))}
  </div>
)

/**
 * The offered filters with their counts, and the sort keys, where the key already sorted by flips its direction and
 * another starts in the direction that answers it.
 */
const useChoices = ({ filter, onFilter, sortKey, sortDir, onSort, counts }: ListToolbarProps) => {
  const intl = useIntl()
  const shown = (f: ListFilter) =>
    intl.formatMessage({ id: '{filter} ({count})', defaultMessage: '{filter} ({count})' }, { filter: intl.formatMessage(FILTER_LABEL[f]), count: counts[f] })
  const filters: Choice[] = offeredFilters(counts, filter).map((f) => ({
    id: f,
    label: intl.formatMessage(FILTER_LABEL[f]),
    name: shown(f),
    count: counts[f],
    on: f === filter,
    pick: () => onFilter(f),
  }))
  const flipLabel = sortDir === 'asc'
    ? intl.formatMessage({ id: 'Sorted ascending, click for descending', defaultMessage: 'Sorted ascending, click for descending' })
    : intl.formatMessage({ id: 'Sorted descending, click for ascending', defaultMessage: 'Sorted descending, click for ascending' })
  const sorts: Choice[] = (Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({
    id: key,
    label: intl.formatMessage(SORT_LABEL[key]),
    on: key === sortKey,
    arrow: sortDir,
    title: key === sortKey ? flipLabel : undefined,
    pick: () => onSort(key, key !== sortKey ? NATURAL_DIR[key] : sortDir === 'asc' ? 'desc' : 'asc'),
  }))
  return {
    filters,
    sorts,
    flipLabel,
    shown,
    show: intl.formatMessage({ id: 'Show#verb', defaultMessage: 'Show', description: 'verb' }),
    sort: intl.formatMessage({ id: 'Sort', defaultMessage: 'Sort' }),
    sortBy: intl.formatMessage({ id: 'Sort by {label}', defaultMessage: 'Sort by {label}' }, { label: intl.formatMessage(SORT_LABEL[sortKey]) }),
    first: sortDir === 'asc'
      ? intl.formatMessage({ id: 'Smallest first', defaultMessage: 'Smallest first' })
      : intl.formatMessage({ id: 'Largest first', defaultMessage: 'Largest first' }),
  }
}

/** A control's menu: open or not, and the control it hangs from. */
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

const ChipsDesign = (props: ListToolbarProps) => {
  const intl = useIntl()
  const { filters, sorts, shown, show, sort, sortBy, first } = useChoices(props)
  const showMenu = useMenu()
  const sortMenu = useMenu()
  return (
    <>
      <button
        type="button" className="chip show" {...showMenu.trigger}
        aria-label={intl.formatMessage({ id: 'Show: {filter}', defaultMessage: 'Show: {filter}' }, { filter: shown(props.filter) })}
      >
        <span className="value">{intl.formatMessage(FILTER_LABEL[props.filter])}</span>
        <span className="count">{props.counts[props.filter]}</span>
        <ChevronDown className="chev" aria-hidden="true"/>
      </button>
      <button type="button" className="chip sort" {...sortMenu.trigger} aria-label={sortBy} {...hint(first)}>
        <DirIcon dir={props.sortDir}/>
        <span className="value">{intl.formatMessage(SORT_LABEL[props.sortKey])}</span>
        <ChevronDown className="chev" aria-hidden="true"/>
      </button>
      <ViewSwitch view={props.view} onView={props.onView}/>
      {showMenu.open && (
        <MenuSurface placement={{ kind: 'under', of: showMenu.anchor, align: 'start' }} label={show} onClose={showMenu.close}>
          <div css={choicesStyle}><Choices label={show} choices={filters} onChose={showMenu.close}/></div>
        </MenuSurface>
      )}
      {sortMenu.open && (
        <MenuSurface placement={{ kind: 'under', of: sortMenu.anchor, align: 'start' }} label={sort} onClose={sortMenu.close}>
          <div css={choicesStyle}><Choices label={sort} choices={sorts} onChose={sortMenu.close}/></div>
        </MenuSurface>
      )}
    </>
  )
}

const OneButtonDesign = (props: ListToolbarProps) => {
  const intl = useIntl()
  const { filters, sorts, flipLabel, show, sort } = useChoices(props)
  const [open, setOpen] = useState(false)
  const label = intl.formatMessage({ id: 'Show and sort', defaultMessage: 'Show and sort' })
  const changed = props.filter !== 'all' || props.sortKey !== DEFAULT_SORT.key || props.sortDir !== DEFAULT_SORT.dir
  // the options dialog's surface, which stays open as choices are made, so a filter and a sort take one visit
  const groups: OptionGroup[] = [
    { id: 'show', label: show, items: filters.map((f) => ({ kind: 'radio', id: f.id, group: 'show', label: f.name ?? f.label, selected: f.on, apply: f.pick })) },
    {
      id: 'sort',
      label: sort,
      items: sorts.map((s) => ({
        kind: 'radio', id: s.id, group: 'sort', label: s.label, selected: s.on, apply: s.pick,
        icon: s.on ? <DirIcon dir={props.sortDir} label={flipLabel}/> : undefined,
      })),
    },
  ]
  return (
    <>
      <button
        type="button" className="square tune" aria-haspopup="dialog" aria-expanded={open}
        aria-label={label} {...hint(label)} onClick={() => setOpen(true)}
      >
        <SlidersHorizontal aria-hidden="true"/>
        {changed && <span className="dot" aria-hidden="true"/>}
      </button>
      <ViewSwitch view={props.view} onView={props.onView}/>
      {open && <TorrentOptionsDialog title={label} groups={groups} onClose={() => setOpen(false)}/>}
    </>
  )
}

const StripDesign = (props: ListToolbarProps) => {
  const { filters, sorts, show, sort, sortBy, first } = useChoices(props)
  const menu = useMenu()
  const strip = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<[number, number]>([0, 0])
  const readEnds = useCallback(() => {
    const box = strip.current
    if (!box) return
    const on = box.querySelector<HTMLElement>('[aria-pressed="true"]')
    // an end fades only where chips are past it, and never over the chosen chip, whose highlight starts at its edge
    const width = (more: boolean, room: number) =>
      !more ? 0 : on && room > -on.offsetWidth ? Math.max(0, Math.min(FADE, room)) : FADE
    const start = width(box.scrollLeft > 1, on ? on.offsetLeft - box.scrollLeft : 0)
    const end = width(
      box.scrollLeft + box.clientWidth < box.scrollWidth - 1,
      on ? box.scrollLeft + box.clientWidth - on.offsetLeft - on.offsetWidth : 0,
    )
    setFade((was) => (was[0] === start && was[1] === end ? was : [start, end]))
  }, [])
  // after every render, as the chips change with the counts, and whenever the strip's own room does
  useLayoutEffect(readEnds)
  useEffect(() => {
    const box = strip.current
    if (!box) return
    const observer = new ResizeObserver(readEnds)
    observer.observe(box)
    return () => observer.disconnect()
  }, [readEnds])
  // the chosen chip scrolled into the strip, as a filter remembered from the last visit can sit past its end, with
  // the fade's width to spare on the side it comes in from, or half of what room the strip has around it; a chip
  // wider than the strip shows its start, where its highlight is
  useLayoutEffect(() => {
    const box = strip.current
    const on = box?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!box || !on) return
    const spare = Math.min(FADE, Math.max(0, box.clientWidth - on.offsetWidth) / 2)
    if (on.offsetLeft - spare < box.scrollLeft || on.offsetWidth > box.clientWidth) box.scrollLeft = on.offsetLeft - spare
    else if (on.offsetLeft + on.offsetWidth + spare > box.scrollLeft + box.clientWidth) box.scrollLeft = on.offsetLeft + on.offsetWidth + spare - box.clientWidth
    readEnds()
  }, [props.filter, readEnds])
  return (
    <>
      <div
        className="strip" role="group" aria-label={show} ref={strip} onScroll={readEnds}
        style={{ '--fade-start': `${fade[0]}px`, '--fade-end': `${fade[1]}px` } as CSSProperties}
      >
        {filters.map((f) => (
          <button key={f.id} type="button" aria-pressed={f.on} aria-label={f.name} onClick={f.pick}>
            {f.label}<span className="count">{f.count}</span>
          </button>
        ))}
      </div>
      <button type="button" className="square" {...menu.trigger} aria-label={sortBy} {...hint(first)}>
        <DirIcon dir={props.sortDir}/>
      </button>
      <ViewSwitch view={props.view} onView={props.onView}/>
      {menu.open && (
        <MenuSurface placement={{ kind: 'under', of: menu.anchor }} label={sort} onClose={menu.close}>
          <div css={choicesStyle}><Choices label={sort} choices={sorts} onChose={menu.close}/></div>
        </MenuSurface>
      )}
    </>
  )
}

const DESIGNS = { a: ChipsDesign, b: OneButtonDesign, c: StripDesign }

export const CompactToolbar = ({ design, ...props }: ListToolbarProps & { design: CompactDesign }) => {
  const Design = DESIGNS[design]
  return (
    <div css={style} className={`list-toolbar compact design-${design}`}>
      <PickAll picked={props.picked} canPick={props.canPick} onPickAll={props.onPickAll}/>
      <Design {...props}/>
    </div>
  )
}
