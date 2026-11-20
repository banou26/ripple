// The buttons a plugin answers as ripple draws them: what is left out, each place's count, and the icon's limits.
import type { Button } from '../../src/plugins/contract'

import { describe, expect, it } from 'vitest'

import { cleanButtons, drawnIn, ICON_BYTES, LABEL_MAX, letterOf, maskOf } from '../../src/plugins/buttons'

const ICON = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Ccircle cx=%2712%27 cy=%2712%27 r=%2710%27/%3E%3C/svg%3E'
const button = (over: object = {}): Button => ({ id: 'a', place: 'header', label: 'Group by tracker', ...over })

describe('a plugin\'s buttons', () => {
  it('keeps a label of up to 40 characters, as a person counts them, and leaves out an empty or longer one', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(cleanButtons([button({ label: 'x'.repeat(LABEL_MAX) })])).toHaveLength(1)
    expect(cleanButtons([button({ label: family.repeat(LABEL_MAX) })]), 'forty families of three are forty characters').toHaveLength(1)
    expect(cleanButtons([button({ label: 'x'.repeat(LABEL_MAX + 1) })])).toEqual([])
    expect(cleanButtons([button({ label: '   ' }), button({ id: 'b', label: 7 })])).toEqual([])
    expect(cleanButtons([button({ label: '  Sort  ' })])[0]!.label).toBe('Sort')
  })

  it('draws one per plugin in the header and in Settings, and three in a torrent\'s menu, the first ones', () => {
    const many = (place: string) => ['1', '2', '3', '4'].map((id) => button({ id, place, label: `Item ${id}` }))
    expect(cleanButtons(many('header')).map((b) => b.id)).toEqual(['1'])
    expect(cleanButtons(many('settings')).map((b) => b.id)).toEqual(['1'])
    expect(cleanButtons(many('row-menu')).map((b) => b.id)).toEqual(['1', '2', '3'])
    expect(cleanButtons([...many('header'), ...many('settings').map((b) => ({ ...b, id: `s${b.id}` }))]).map((b) => b.id)).toEqual(['1', 's1'])
  })

  it('leaves out a place this ripple does not draw, a repeated id and anything that is no button', () => {
    expect(cleanButtons([button({ place: 'player' }), button({ place: 'toString' }), button({ id: '' }), null, 'header', 4])).toEqual([])
    expect(cleanButtons([button({ place: 'row-menu' }), button({ place: 'row-menu' })])).toHaveLength(1)
    expect(cleanButtons({ length: 1, 0: button() })).toEqual([])
    expect(cleanButtons([button()]), 'the control').toEqual([{ id: 'a', place: 'header', label: 'Group by tracker' }])
  })

  it('keeps an SVG data url of 4 KB at most as its icon, and draws its first letter for any other', () => {
    expect(cleanButtons([button({ icon: ICON, mirror: true })])[0]).toEqual({ ...button(), icon: ICON, mirror: true })
    const edge = ICON + 'x'.repeat(ICON_BYTES - ICON.length)
    expect(cleanButtons([button({ icon: edge })])[0]!.icon).toBe(edge)
    expect(cleanButtons([button({ icon: edge + 'x' })])[0]!.icon).toBeUndefined()
    // a page of its own would be a request ripple makes, with the person's address, to wherever it points
    for (const icon of ['https://tracker.example/icon.svg', 'data:image/png;base64,AAAA', '/icon.svg', 'javascript:alert(1)']) {
      expect(cleanButtons([button({ icon })])[0], icon).toEqual(button())
    }
    expect(cleanButtons([button({ mirror: 'yes' })])[0]!.mirror).toBeUndefined()
    expect(letterOf('group by tracker', 'en')).toBe('G')
    expect(letterOf('\u05e7\u05d1\u05d5\u05e6\u05d5\u05ea', 'he')).toBe('\u05e7')
  })

  it('writes an icon into CSS whole, quotes and backslashes included', () => {
    const icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0\\"/></svg>'
    const mask = maskOf(icon)
    expect(mask.startsWith('url("') && mask.endsWith('")')).toBe(true)
    expect(mask.slice(5, -2)).not.toMatch(/["\\]/)
    expect(decodeURIComponent(mask.slice(5, -2))).toBe(icon)
  })
})

describe('the buttons a place draws', () => {
  const kept = {
    'npm:b': { name: 'Second', installedAt: 2, locales: { en: [button({ id: 'b' })], he: [button({ id: 'b-he', label: '\u05e7' })] } },
    'npm:a': { name: 'First', installedAt: 1, locales: { en: [button({ id: 'a' }), button({ id: 'menu', place: 'row-menu' })] } },
  }

  it('are each plugin\'s in install order, in the language shown, and the place\'s alone', () => {
    expect(drawnIn(kept, 'en', 'header').map((d) => [d.uri, d.name, d.button.id])).toEqual([['npm:a', 'First', 'a'], ['npm:b', 'Second', 'b']])
    expect(drawnIn(kept, 'he', 'header').map((d) => d.button.id)).toEqual(['b-he'])
    expect(drawnIn(kept, 'en', 'row-menu').map((d) => d.button.id)).toEqual(['menu'])
    expect(drawnIn(undefined, 'en', 'header')).toEqual([])
  })
})
