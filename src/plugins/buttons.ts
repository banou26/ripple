import type { Button, ButtonPage, ButtonPlace, PageSize } from './contract'
import type { KeptButtons } from './switches'

export const LABEL_MAX = 40
export const ICON_BYTES = 4 * 1024
/** How long a plugin gets to answer `buttons`, after which the buttons kept stay. */
export const BUTTONS_MS = 5_000
/** How often `ui.buttonsChanged()` counts. */
export const BUTTONS_CHANGED_MS = 1_000
/** How long a click waits for the plugin, while it connects and while it answers, before one line says it did not. */
export const CLICK_MS = 10_000
/** A plugin's buttons in each place. */
export const PER_PLUGIN: Readonly<Record<ButtonPlace, number>> = {
  header: 1,
  'add-field': 1,
  'row-menu': 3,
  'bulk-bar': 1,
  detail: 1,
  file: 1,
  player: 1,
  settings: 1,
}
/** The plugins whose header button is drawn in the header, in install order; the rest are in its More menu. */
export const HEADER_INLINE = 2
/** The plugins drawn inline in each inline place, in install order; the rest are in that place's More menu. */
export const PLACE_INLINE = {
  header: HEADER_INLINE,
  'add-field': 1,
  'bulk-bar': 2,
  detail: 2,
  file: 1,
  player: 1,
} as const
/**
 * The header's add field keeps its text this wide beside the plugins' buttons, where its hint, the page's only word on
 * how to add anything, still reads: short of it, they take a row of their own. scripts/test-header-layout.mjs holds
 * the header to it.
 */
export const TEXT_FLOOR = 210

const ICON = /^data:image\/svg\+xml[;,]/

export const isPageSize = (value: unknown): value is PageSize =>
  value === 'small' || value === 'medium' || value === 'large'

const cleanPage = (raw: unknown): ButtonPage | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const { id, size } = raw as Record<string, unknown>
  const trimmed = typeof id === 'string' ? id.trim() : ''
  if (!trimmed) return undefined
  return { id: trimmed, ...(isPageSize(size) && { size }) }
}

/** The label's length in characters, as a person counts them. */
const characters = (text: string) => [...new Intl.Segmenter().segment(text)].length

/** A plugin's answer to `buttons` as ripple draws it: each button checked, and each place held to its count. */
export const cleanButtons = (answer: unknown): Button[] => {
  if (!Array.isArray(answer)) return []
  const ids = new Set<string>()
  const counts: Partial<Record<ButtonPlace, number>> = {}
  return answer.flatMap((raw): Button[] => {
    const { id, place, label, icon, mirror, page } = (raw ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || !id || ids.has(id) || typeof place !== 'string' || !Object.hasOwn(PER_PLUGIN, place)) return []
    const text = typeof label === 'string' ? label.trim() : ''
    if (!text || characters(text) > LABEL_MAX) return []
    const at = place as ButtonPlace
    if ((counts[at] ?? 0) >= PER_PLUGIN[at]) return []
    counts[at] = (counts[at] ?? 0) + 1
    ids.add(id)
    const drawn = typeof icon === 'string' && ICON.test(icon) && new TextEncoder().encode(icon).byteLength <= ICON_BYTES
    const opens = cleanPage(page)
    return [{ id, place: at, label: text, ...(drawn && { icon }), ...(mirror === true && { mirror: true }), ...(opens && { page: opens }) }]
  })
}

/** One plugin's button as a place draws it. */
export type Drawn = { uri: string, name: string, button: Button }

/** The buttons each plugin keeps for `place` in `locale`, in install order. */
export const drawnIn = (kept: Readonly<Record<string, KeptButtons>> | undefined, locale: string, place: ButtonPlace): Drawn[] =>
  Object.entries(kept ?? {})
    .sort(([, a], [, b]) => a.installedAt - b.installedAt)
    .flatMap(([uri, plugin]) => (plugin.locales[locale] ?? [])
      .filter((button) => button.place === place)
      .map((button) => ({ uri, name: plugin.name, button })))

/** The icon as a CSS mask: a data url can carry quotes and backslashes, which would end the CSS string early. */
export const maskOf = (icon: string) => `url("${icon.replace(/["\\\n\r]/g, encodeURIComponent)}")`

/** What a button with no icon draws: its label's first letter. */
export const letterOf = (label: string, locale: string) => [...new Intl.Segmenter(locale).segment(label)][0]?.segment.toLocaleUpperCase(locale) ?? ''
