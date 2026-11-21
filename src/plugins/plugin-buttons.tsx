import type { IntlShape } from 'react-intl'
import type { Button, ButtonPlace } from './contract'
import type { Drawn } from './buttons'
import type { OptionGroup } from '../torrent/torrent-options'

import { css } from '@emotion/react'
import { Ellipsis } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIntl } from 'react-intl'

import { hint, typedHint } from '../components/hint'
import { MenuItems, MenuSurface } from '../components/menu'
import { shownLanguage } from '../i18n'
import { hexInfoHash } from '../torrent/magnet'
import { isFramed } from '../utils/framed'
import { drawnIn, HEADER_INLINE, letterOf, maskOf, TEXT_FLOOR } from './buttons'
import { clickButton, connectPlugin } from './host'
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
 * The buttons the plugins keep for `place` in the language shown, in install order; none in a frame. A plugin this
 * device knows that kept none in this language is connected here, once per language, to ask for them.
 */
export const usePlaced = (place: ButtonPlace): Drawn[] => {
  useIntl()
  const kept = useKeptButtons()
  const answers = useAnswers()
  const locale = shownLanguage()
  useEffect(() => {
    if (isFramed() || !kept || !answers) return
    for (const uri of new Set([...Object.keys(kept), ...Object.keys(answers)])) {
      if (kept[uri]?.locales[locale] || tried.has(`${uri} ${locale}`)) continue
      tried.add(`${uri} ${locale}`)
      void connectPlugin(uri)
    }
  }, [kept, answers, locale])
  return isFramed() ? [] : drawnIn(kept, locale, place)
}

const press = ({ uri, name, button }: Drawn, infoHashes?: string[]) =>
  void clickButton(uri, name, button.id, infoHashes ? { infoHashes } : {})

/** A plugin's button in the header or on its Settings row: its icon, its label as tooltip and name. */
export const PluginButton = ({ drawn, className }: { drawn: Drawn, className?: string }) => (
  <button type="button" className={className} aria-label={drawn.button.label} {...typedHint(drawn.button.label)} onClick={() => press(drawn)}>
    <PluginIcon button={drawn.button}/>
  </button>
)

/** Each plugin's buttons as menu groups, under the plugin's name, each pressed with `infoHashes` when given. */
export const pluginGroups = (drawn: readonly Drawn[], infoHashes?: string[]): OptionGroup[] => {
  const groups = new Map<string, OptionGroup>()
  for (const one of drawn) {
    const group = groups.get(one.uri) ?? { id: `plugin ${one.uri}`, label: one.name, typed: true, items: [] }
    group.items.push({ kind: 'action', id: `plugin ${one.uri} ${one.button.id}`, label: one.button.label, typed: true, run: () => press(one, infoHashes) })
    groups.set(one.uri, group)
  }
  return [...groups.values()]
}

/** The plugins' items in a torrent's menu, each pressed with that torrent's info hash. */
export const rowMenuGroups = (drawn: readonly Drawn[], infoHash: string | undefined): OptionGroup[] =>
  infoHash ? pluginGroups(drawn, [hexInfoHash(infoHash)]) : []

const moreLabel = (intl: IntlShape) => intl.formatMessage({ id: 'More', defaultMessage: 'More' })

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
 * The plugins' header buttons, before Create: the first {@link HEADER_INLINE} plugins' in install order, and the rest
 * in one More menu, on a row of their own when the header has no room for them.
 */
export const HeaderButtons = () => {
  const intl = useIntl()
  const drawn = usePlaced('header')
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<HTMLDivElement | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  useOwnRowWhenFull(group)
  const inline = drawn.slice(0, HEADER_INLINE)
  const rest = drawn.slice(HEADER_INLINE)
  const label = moreLabel(intl)
  if (!drawn.length) return null
  return (
    <div className="plugins" css={rowStyle} ref={setGroup}>
      {inline.map((one) => <PluginButton key={one.uri} drawn={one} className="tool plugin"/>)}
      {rest.length > 0 && (
        <button
          type="button" className="tool plugin-more" ref={more} aria-haspopup="menu" aria-expanded={open}
          aria-label={label} {...hint(label)} onClick={() => setOpen((was) => !was)}
        >
          <Ellipsis aria-hidden="true"/>
        </button>
      )}
      {/* in the body, as the account's menu is, so none of the header's rules for its children reach it */}
      {open && rest.length > 0 && createPortal(
        <MenuSurface placement={{ kind: 'under', of: more, align: 'end' }} label={label} onClose={() => setOpen(false)}>
          <MenuItems groups={pluginGroups(rest)} onChose={() => setOpen(false)}/>
        </MenuSurface>,
        document.body,
      )}
    </div>
  )
}
