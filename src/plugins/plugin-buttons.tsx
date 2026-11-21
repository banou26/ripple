import type { KeyboardEvent, MouseEventHandler } from 'react'
import type { IntlShape } from 'react-intl'
import type { Button, ButtonPlace, ClickContext, DetailTab } from './contract'
import type { Drawn } from './buttons'
import type { OptionGroup } from '../torrent/torrent-options'

import { css } from '@emotion/react'
import { Ellipsis } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIntl } from 'react-intl'

import { hint, typedHint } from '../components/hint'
import { MenuItems, MenuSurface } from '../components/menu'
import { TooltipDisplay } from '../components/tooltip-display'
import { shownLanguage } from '../i18n'
import { hexInfoHash } from '../torrent/magnet'
import { drawnIn, letterOf, maskOf, PLACE_INLINE, TEXT_FLOOR } from './buttons'
import { clickButton, connectPlugin, usePluginsHere } from './host'
import { useAnswers, useKeptButtons } from './switches'

const iconStyle = css`
  display: inline-block;
  flex: none;
  width: 17px;
  height: 17px;
  background: currentColor;
  mask: center / contain no-repeat;

  &[data-mirror]:dir(rtl) {
    scale: -1 1;
  }
`

const letterStyle = css`
  font-weight: 700;
  font-size: 0.9rem;
  line-height: 1;
`

/** A plugin's icon in the text colour, or its label's first letter. */
export const PluginIcon = ({ button }: { button: Button }) => (button.icon
  ? <span css={iconStyle} className="plugin-icon" style={{ maskImage: maskOf(button.icon) }} data-mirror={button.mirror || undefined} aria-hidden="true"/>
  : <span css={letterStyle} className="plugin-letter" aria-hidden="true">{letterOf(button.label, shownLanguage())}</span>)

const tried = new Set<string>()

/**
 * The buttons the plugins keep for `place` in the language shown, in install order, once plugins are on here
 * (`pluginsHere`, host.ts). A plugin this device knows that kept none in this language is connected here, once per
 * language, to ask for them.
 */
export const usePlaced = (place: ButtonPlace): Drawn[] => {
  useIntl()
  const kept = useKeptButtons()
  const answers = useAnswers()
  const here = usePluginsHere()
  const locale = shownLanguage()
  useEffect(() => {
    // a player tab connects a plugin only on a click, never on a cache miss at load
    if (!here || !kept || !answers || place === 'player') return
    for (const uri of new Set([...Object.keys(kept), ...Object.keys(answers)])) {
      if (kept[uri]?.locales[locale] || tried.has(`${uri} ${locale}`)) continue
      tried.add(`${uri} ${locale}`)
      void connectPlugin(uri)
    }
  }, [here, kept, answers, locale, place])
  return here ? drawnIn(kept, locale, place) : []
}

const press = ({ uri, name, button }: Drawn, context: ClickContext = {}) =>
  void clickButton(uri, name, button.id, context, button.page)

/** A plugin's button in an inline place or on its Settings row: its icon, its label as tooltip and name. */
export const PluginButton = ({
  drawn, className, context, onMouseDown,
}: {
  drawn: Drawn
  className?: string
  context?: ClickContext
  onMouseDown?: MouseEventHandler<HTMLButtonElement>
}) => (
  <button
    type="button"
    className={className}
    aria-label={drawn.button.label}
    {...typedHint(drawn.button.label)}
    onMouseDown={onMouseDown}
    onClick={() => press(drawn, context)}
  >
    <PluginIcon button={drawn.button}/>
  </button>
)

/** Each plugin's buttons as menu groups, under the plugin's name, each pressed with `context` when given. */
export const pluginGroups = (drawn: readonly Drawn[], context: ClickContext = {}): OptionGroup[] => {
  const groups = new Map<string, OptionGroup>()
  for (const one of drawn) {
    const group = groups.get(one.uri) ?? { id: `plugin ${one.uri}`, label: one.name, typed: true, items: [] }
    group.items.push({ kind: 'action', id: `plugin ${one.uri} ${one.button.id}`, label: one.button.label, typed: true, run: () => press(one, context) })
    groups.set(one.uri, group)
  }
  return [...groups.values()]
}

/** The plugins' items in a torrent's menu, each pressed with that torrent's info hash. */
export const rowMenuGroups = (drawn: readonly Drawn[], infoHash: string | undefined): OptionGroup[] =>
  infoHash ? pluginGroups(drawn, { infoHashes: [hexInfoHash(infoHash)] }) : []

const moreLabel = (intl: IntlShape) => intl.formatMessage({ id: 'More', defaultMessage: 'More' })

const MoreButton = ({
  rest, className, context, onMouseDown, buttonRef, onOpenChange,
}: {
  rest: readonly Drawn[]
  className: string
  context?: ClickContext
  onMouseDown?: MouseEventHandler<HTMLButtonElement>
  buttonRef?: (el: HTMLButtonElement | null) => void
  onOpenChange?: (open: boolean) => void
}) => {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const openChange = useRef(onOpenChange)
  useEffect(() => { openChange.current = onOpenChange })
  const label = moreLabel(intl)
  // report open state from an effect so MenuSurface returns focus to the trigger before a folded field hides it
  useEffect(() => {
    if (!open) return
    openChange.current?.(true)
    return () => { openChange.current?.(false) }
  }, [open])
  if (!rest.length) return null
  return (
    <>
      <button
        type="button" className={className} ref={(el) => { more.current = el; buttonRef?.(el) }} aria-haspopup="menu" aria-expanded={open}
        aria-label={label} {...hint(label)} onMouseDown={onMouseDown} onClick={() => setOpen((was) => !was)}
      >
        <Ellipsis aria-hidden="true"/>
      </button>
      {/* in the body, as the account's menu is, so none of the bar's rules for its children reach it */}
      {open && createPortal(
        <MenuSurface placement={{ kind: 'under', of: more, align: 'end' }} label={label} onClose={() => setOpen(false)}>
          <MenuItems groups={pluginGroups(rest, context)} onChose={() => setOpen(false)}/>
        </MenuSurface>,
        document.body,
      )}
    </>
  )
}

const rowStyle = css`
  display: flex;
  flex: none;
  gap: inherit;
`

/**
 * Marks the header `data-plugins-wrapped` while `group` does not fit beside its other items: they would reach past it,
 * or squeezed, one of them would wrap and the bar grow, or the add field's text be under {@link TEXT_FLOOR}. The
 * header's rule for that mark takes `group` out of its row, which is the row measured alone. Measured whenever one of
 * them changes size, and never while a search unfolds the field over them.
 */
const useOwnRowWhenFull = (group: HTMLElement | null) => useLayoutEffect(() => {
  const header = group?.parentElement
  if (!group || !header) return
  const heights = () => [...header.children].filter((item) => item !== group).map((item) => item.getBoundingClientRect().height)
  const text = () => header.querySelector(':scope > form input:not([type=file])')
  const fit = () => {
    if (header.hasAttribute('data-searching')) return
    header.setAttribute('data-plugins-wrapped', '')
    const alone = heights()
    header.removeAttribute('data-plugins-wrapped')
    const grown = heights().some((height, at) => height > (alone[at] ?? height) + 0.5)
    const squeezed = (text()?.getBoundingClientRect().width ?? TEXT_FLOOR) < TEXT_FLOOR
    if (header.scrollWidth > header.clientWidth || grown || squeezed) header.setAttribute('data-plugins-wrapped', '')
  }
  const sizes = new ResizeObserver(fit)
  const watch = () => {
    sizes.disconnect()
    sizes.observe(header)
    for (const item of header.children) if (item !== group) sizes.observe(item)
    // a phone's field folds and unfolds in a form as wide as before, so the text is watched itself
    const field = text()
    if (field) sizes.observe(field)
  }
  const items = new MutationObserver(() => { watch(); fit() })
  items.observe(header, { childList: true })
  watch()
  fit()
  return () => {
    sizes.disconnect()
    items.disconnect()
    header.removeAttribute('data-plugins-wrapped')
  }
}, [group])

/**
 * The plugins' header buttons, before Create: the first {@link PLACE_INLINE.header} plugins' in install order, and the
 * rest in one More menu, on a row of their own when the header has no room for them.
 */
export const HeaderButtons = () => {
  const drawn = usePlaced('header')
  const [group, setGroup] = useState<HTMLDivElement | null>(null)
  useOwnRowWhenFull(group)
  if (!drawn.length) return null
  const inline = drawn.slice(0, PLACE_INLINE.header)
  const rest = drawn.slice(PLACE_INLINE.header)
  return (
    <div className="plugins" css={rowStyle} ref={setGroup}>
      {inline.map((one) => <PluginButton key={one.uri} drawn={one} className="tool plugin"/>)}
      <MoreButton rest={rest} className="tool plugin-more"/>
    </div>
  )
}

/**
 * The plugins' add-field buttons, before Open a .torrent file: 1 inline and the rest in More, pressed with `{ text }`.
 * When the pill is too narrow for two extra icons to leave the text at {@link TEXT_FLOOR}, every plugin folds into the
 * single More button so the input stays readable and every plugin stays reachable.
 */
export const AddFieldButtons = ({
  text, onMouseDown, onMenuOpenChange,
}: {
  text: string
  onMouseDown?: MouseEventHandler<HTMLButtonElement>
  onMenuOpenChange?: (open: boolean) => void
}) => {
  const drawn = usePlaced('add-field')
  const [compact, setCompact] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const many = drawn.length > PLACE_INLINE['add-field']
  useLayoutEffect(() => {
    const field = anchor?.closest<HTMLElement>('.field')
    const input = field?.querySelector<HTMLElement>('input:not([type=file])')
    if (!many || !field || !input) return
    const fit = () => {
      const width = input.getBoundingClientRect().width
      // 38 px hysteresis (34 px button + 2 px gap + 2 px margin) keeps this from oscillating across the threshold
      setCompact((was) => (was ? width < TEXT_FLOOR + 38 : width < TEXT_FLOOR))
    }
    const observer = new ResizeObserver(fit)
    observer.observe(field)
    observer.observe(input)
    fit()
    return () => observer.disconnect()
  }, [anchor, many])
  if (!drawn.length) return null
  const fold = many && compact
  const context: ClickContext = { text }
  const inline = fold ? [] : drawn.slice(0, PLACE_INLINE['add-field'])
  const rest = fold ? drawn : drawn.slice(PLACE_INLINE['add-field'])
  return (
    <>
      {inline.map((one) => (
        <PluginButton key={one.uri} drawn={one} className="icon plugin" context={context} onMouseDown={onMouseDown}/>
      ))}
      <MoreButton rest={rest} className="icon plugin-more" context={context} onMouseDown={onMouseDown} buttonRef={setAnchor} onOpenChange={onMenuOpenChange}/>
    </>
  )
}

/** The plugins' bulk-bar buttons, before Remove: 2 inline and the rest in More, pressed with `{ infoHashes }`. */
export const BulkBarButtons = ({ infoHashes }: { infoHashes: string[] }) => {
  const drawn = usePlaced('bulk-bar')
  if (!drawn.length) return null
  const context: ClickContext = { infoHashes: infoHashes.map(hexInfoHash) }
  return (
    <>
      {drawn.slice(0, PLACE_INLINE['bulk-bar']).map((one) => (
        <PluginButton key={one.uri} drawn={one} className="icon plugin" context={context}/>
      ))}
      <MoreButton rest={drawn.slice(PLACE_INLINE['bulk-bar'])} className="icon plugin-more" context={context}/>
    </>
  )
}

/** The plugins' details-header buttons, before Close: 2 inline and the rest in More, pressed with `{ infoHash, tab }`. */
export const DetailButtons = ({ infoHash, tab }: { infoHash: string, tab: DetailTab }) => {
  const drawn = usePlaced('detail')
  if (!drawn.length) return null
  const context: ClickContext = { infoHash: hexInfoHash(infoHash), tab }
  return (
    <>
      {drawn.slice(0, PLACE_INLINE.detail).map((one) => (
        <PluginButton key={one.uri} drawn={one} className="plugin" context={context}/>
      ))}
      <MoreButton rest={drawn.slice(PLACE_INLINE.detail)} className="plugin-more" context={context}/>
    </>
  )
}

/** The plugins' file-row buttons, beside Save: 1 inline and the rest in More, pressed with `{ infoHash, file }`. */
export const FileButtons = ({ infoHash, file }: { infoHash: string, file: number }) => {
  const drawn = usePlaced('file')
  if (!drawn.length) return null
  const context: ClickContext = { infoHash: hexInfoHash(infoHash), file }
  return (
    <>
      {drawn.slice(0, PLACE_INLINE.file).map((one) => (
        <PluginButton key={one.uri} drawn={one} className="plugin" context={context}/>
      ))}
      <MoreButton rest={drawn.slice(PLACE_INLINE.file)} className="plugin-more" context={context}/>
    </>
  )
}

const stopSpace = (e: KeyboardEvent) => { if (e.key === ' ') e.stopPropagation() }

/**
 * The plugins' player buttons, beside Open in Ripple: 1 inline and the rest in More, drawn with `TooltipDisplay`
 * in the player's overlay and pressed with `{ infoHash, file, time }`.
 */
export const PlayerButtons = ({ infoHash, file, getTime, container }: {
  infoHash: string
  file: number
  getTime: () => number
  container: HTMLElement | null
}) => {
  const intl = useIntl()
  const drawn = usePlaced('player')
  const [open, setOpen] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  if (!drawn.length) return null
  const inline = drawn.slice(0, PLACE_INLINE.player)
  const rest = drawn.slice(PLACE_INLINE.player)
  const context = (): ClickContext => ({ infoHash: hexInfoHash(infoHash), file, time: getTime() })
  const label = moreLabel(intl)
  const byPlugin = new Map<string, OptionGroup>()
  for (const one of rest) {
    const group = byPlugin.get(one.uri) ?? { id: `plugin ${one.uri}`, label: one.name, typed: true, items: [] }
    group.items.push({ kind: 'action', id: `plugin ${one.uri} ${one.button.id}`, label: one.button.label, typed: true, run: () => press(one, context()) })
    byPlugin.set(one.uri, group)
  }
  const groups = [...byPlugin.values()]
  return (
    <>
      {inline.map((one) => (
        <TooltipDisplay
          key={one.uri}
          id={`plugin-player-${one.uri}`}
          tooltipPlace="bottom-end"
          text={(
            <button
              type="button"
              className="item link plugin"
              aria-label={one.button.label}
              onClick={() => press(one, context())}
              onKeyDown={stopSpace}
            >
              <PluginIcon button={one.button}/>
            </button>
          )}
          toolTipText={<span dir="auto">{one.button.label}</span>}
        />
      ))}
      {rest.length > 0 && (
        <>
          <TooltipDisplay
            id="plugin-player-more"
            tooltipPlace="bottom-end"
            disabled={open}
            text={(
              <button
                type="button"
                ref={more}
                className="item link plugin-more"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={label}
                onClick={() => setOpen((was) => !was)}
                onKeyDown={stopSpace}
              >
                <Ellipsis aria-hidden="true"/>
              </button>
            )}
            toolTipText={<span>{label}</span>}
          />
          {open && createPortal(
            <MenuSurface placement={{ kind: 'under', of: more, align: 'end' }} label={label} onClose={() => setOpen(false)}>
              <MenuItems groups={groups} onChose={() => setOpen(false)}/>
            </MenuSurface>,
            container ?? document.body,
          )}
        </>
      )}
    </>
  )
}
