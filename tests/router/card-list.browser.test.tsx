import type { Torrent } from '../../src/torrent/types'
import type { ListFilter } from '../../src/torrent/list-view'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'
import es419 from '../../src/locales/es-419.json'
import ja from '../../src/locales/ja.json'
import ko from '../../src/locales/ko.json'
import ptBR from '../../src/locales/pt-BR.json'
import tr from '../../src/locales/tr.json'
import { useBulkSelection } from '../../src/router/bulk-selection'
import { useOrderedTorrents } from '../../src/router/use-ordered-torrents'
import { cardGroups } from '../../src/torrent/list-view'
import { showEnglish, showIn } from '../i18n/show-in'

vi.mock('../../src/torrent/use-thumbnails', () => ({
  useThumbnail: () => null,
  useThumbnailGeneration: () => {},
}))

/**
 * The library's cards under their group headings, wired as the page wires them: the held order and groups, the
 * headings only under a filter that mixes states, and a shift+click run in the order the cards are drawn.
 */
let n = 0
const t = (name: string, state: Torrent['state'], addedAt: number): Torrent => {
  const i = n++
  return {
    id: String(i), infoHash: i.toString(16).padStart(40, 'b'), name, size: 1_000_000_000, downloaded: 0,
    progress: state === 'seeding' ? 1 : 0.5, state, down: 0, up: 0, peers: 0, seeds: 0, eta: '-', flags: 0,
    queuePosition: -1, stats: null, addedAt,
  }
}

// newest first, so the date order runs across the groups: Seed one, Down one, Held, Down two, Seed two, Ghost
const LIBRARY = [
  t('Seed one', 'seeding', 6), t('Down one', 'downloading', 5), t('Held', 'paused', 4),
  t('Down two', 'downloading', 3), t('Seed two', 'seeding', 2), t('Ghost', 'missing', 1),
]

const handlers = {
  saving: {}, onToggle: vi.fn(), onSave: vi.fn(), onSaveZip: vi.fn(), onStart: vi.fn(), onOptions: vi.fn(),
  selected: false, onSelect: vi.fn(), savedToUserStorage: false,
}

const mount = async (filter: ListFilter = 'all', first: Torrent[] = LIBRARY) => {
  const { CardList, TorrentRow, style } = await import('../../src/router/home')
  const clock = { now: 1_000_000 }
  const Library = ({ torrents }: { torrents: Torrent[] }) => {
    const { rows, groupOf, interaction } = useOrderedTorrents(torrents, filter, 'added', 'desc', () => clock.now)
    const groups = cardGroups(rows, filter, groupOf)
    const bulk = useBulkSelection(groups.flatMap((g) => g.rows))
    return (
      <div css={style}><main {...interaction}>
        <CardList
          groups={groups}
          row={(x) => <TorrentRow key={x.id} t={x} {...handlers} checked={bulk.picked.has(x.infoHash!)} onPick={bulk.toggle}/>}
        />
      </main></div>
    )
  }
  const container = document.createElement('div')
  container.style.cssText = 'width: 1200px; height: 700px; display: flex; flex-direction: column;'
  document.body.append(container)
  const page = (torrents: Torrent[]) => <IntlRoot><MemoryRouter><Library torrents={torrents}/></MemoryRouter></IntlRoot>
  const screen = await render(page(first), { container })
  /** The page from the top down: each heading as its words, each card as its name. */
  const drawn = () => [...screen.container.querySelectorAll('main .group-head, main .torrent')]
    .map((el) => el.matches('.group-head') ? `# ${(el as HTMLElement).innerText.replace(/\s+/g, ' ')}` : el.querySelector('.title strong')!.textContent)
  const card = (name: string) => [...screen.container.querySelectorAll('.torrent')].find((el) => el.querySelector('.title strong')!.textContent === name)!
  return { screen, clock, drawn, card, rerender: (torrents: Torrent[]) => screen.rerender(page(torrents)) }
}

describe('the cards under their group headings', () => {
  it('stands each card under its heading and count, in the date order within each', async () => {
    const { screen, drawn } = await mount()
    expect(drawn()).toEqual([
      '# Downloading 2', 'Down one', 'Down two',
      '# Paused 1', 'Held',
      '# Done 2', 'Seed one', 'Seed two',
      '# Not on this device 1', 'Ghost',
    ])
    // the count is a word of its own in the heading's name, not run into the label
    await expect.element(screen.getByRole('heading', { name: 'Downloading 2' })).toBeInTheDocument()
  })

  /** A heading names a group, so never the sentence a row's line says, which reads wrong beside it in some languages. */
  it('names each heading as a group in the language of the page', async () => {
    try {
      await showIn('ko', ko)
      expect((await mount()).drawn().filter((line) => line?.startsWith('# '))).toEqual(['# 다운로드 중 2', '# 일시 중지됨 1', '# 완료 2', '# 이 기기에 없음 1'])
      for (const [language, catalogue, heading] of [
        ['ja', ja, 'このデバイスにない'],
        ['tr', tr, 'Bu cihazda olmayanlar'],
        ['es-419', es419, 'No están en este dispositivo'],
        ['pt-BR', ptBR, 'Não estão neste dispositivo'],
      ] as const) {
        await showIn(language, catalogue)
        expect((await mount()).drawn().at(-2), language).toBe(`# ${heading} 1`)
      }
    } finally {
      await showEnglish()
    }
  })

  it('writes a heading\'s count as every count is written, ungrouped', async () => {
    const { CardList } = await import('../../src/router/home')
    const screen = await render(<IntlRoot><CardList groups={[{ group: 'active', rows: Array(1180).fill(LIBRARY[1]) }]} row={() => null}/></IntlRoot>)
    expect(screen.container.querySelector('.group-head .count')?.textContent).toBe('1180')
  })

  it('draws no heading under a filter of one state', async () => {
    const { drawn } = await mount('seeding')
    expect(drawn()).toEqual(['Seed one', 'Seed two'])
  })

  it('runs a shift+click across the headings in the order the cards are drawn', async () => {
    const { screen, drawn } = await mount()
    const box = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` })
    await userEvent.click(box('Down two'))
    await userEvent.click(box('Seed one'), { modifiers: ['Shift'] })
    const ticked = [...screen.container.querySelectorAll<HTMLElement>('.torrent')]
      .filter((el) => el.querySelector<HTMLInputElement>('.row-check input')!.checked)
      .map((el) => el.querySelector('.title strong')!.textContent)
    // in date order the run would be Seed one, Down one, Held and Down two
    expect(ticked).toEqual(['Down two', 'Held', 'Seed one'])
    expect(drawn()).toContain('Down one')
  })

  /** Pausing the card under the pointer must not slide the next card's Pause button into its place. */
  it('keeps a card under its heading while the pointer is in the list, then moves the same card', async () => {
    const { screen, clock, drawn, card, rerender } = await mount()
    const before = card('Down one')
    await userEvent.hover(before)
    const paused = LIBRARY.map((x) => x.name === 'Down one' ? { ...x, state: 'paused' as const } : { ...x })
    await rerender(paused)
    clock.now += 3_000
    await rerender(paused.map((x) => ({ ...x })))
    expect(drawn().slice(0, 3)).toEqual(['# Downloading 2', 'Down one', 'Down two'])
    expect(card('Down one').querySelector('.badge')!.textContent).toBe('Paused')

    // the pointer gone and the quiet passed, it goes under Paused, moved rather than drawn again
    await userEvent.unhover(before)
    await userEvent.hover(screen.container.ownerDocument.body, { position: { x: 1, y: 1 } })
    clock.now += 3_000
    await rerender(paused.map((x) => ({ ...x })))
    expect(drawn().slice(0, 5)).toEqual(['# Downloading 1', 'Down two', '# Paused 2', 'Down one', 'Held'])
    expect(card('Down one')).toBe(before)
  })

  /** The hold is for aiming, so a pointer resting on the list cannot keep a card under the wrong heading for good. */
  it('moves the card after 10 s even with the pointer still in the list', async () => {
    const { REORDER_CEILING_MS } = await import('../../src/torrent/list-view')
    const { screen, clock, drawn, card, rerender } = await mount()
    await userEvent.hover(card('Down one'))
    const paused = LIBRARY.map((x) => x.name === 'Down one' ? { ...x, state: 'paused' as const } : { ...x })
    await rerender(paused)
    clock.now += REORDER_CEILING_MS - 1_000
    await rerender(paused.map((x) => ({ ...x })))
    expect(drawn().slice(0, 3)).toEqual(['# Downloading 2', 'Down one', 'Down two'])
    clock.now += 2_000
    await rerender(paused.map((x) => ({ ...x })))
    expect(drawn().slice(0, 5)).toEqual(['# Downloading 1', 'Down two', '# Paused 2', 'Down one', 'Held'])
    await userEvent.hover(screen.container.ownerDocument.body, { position: { x: 1, y: 1 } })
  })

  /** After a reload every row is Starting for a moment, and nothing was ever drawn under a heading to hold. */
  it('stands a row under its own heading once the engine reports it, even with the pointer in the list', async () => {
    const starting = LIBRARY.map((x) => x.state === 'missing' ? x : { ...x, id: 'starting:' + x.infoHash, state: 'starting' as const })
    const { screen, clock, drawn, card, rerender } = await mount('all', starting)
    expect(drawn().slice(0, 6)).toEqual(['# Downloading 5', 'Seed one', 'Down one', 'Held', 'Down two', 'Seed two'])
    await userEvent.hover(card('Held'))
    await rerender(LIBRARY.map((x) => ({ ...x })))
    clock.now += 500
    await rerender(LIBRARY.map((x) => ({ ...x })))
    expect(drawn()).toEqual([
      '# Downloading 2', 'Down one', 'Down two',
      '# Paused 1', 'Held',
      '# Done 2', 'Seed one', 'Seed two',
      '# Not on this device 1', 'Ghost',
    ])
    await userEvent.hover(screen.container.ownerDocument.body, { position: { x: 1, y: 1 } })
  })

  /** A row started from Not on this device takes a new id, and the click that started it must not see it jump away. */
  it('holds a started card under its heading by its info hash, then moves it', async () => {
    const { screen, clock, drawn, card, rerender } = await mount()
    await userEvent.hover(card('Ghost'))
    const started = LIBRARY.map((x) => x.state === 'missing' ? { ...x, id: 'starting:' + x.infoHash, state: 'starting' as const } : { ...x })
    await rerender(started)
    clock.now += 500
    await rerender(started.map((x) => ({ ...x })))
    expect(drawn().slice(-2)).toEqual(['# Not on this device 1', 'Ghost'])
    expect(card('Ghost').matches('.starting')).toBe(true)

    await userEvent.hover(screen.container.ownerDocument.body, { position: { x: 1, y: 1 } })
    clock.now += 3_000
    await rerender(started.map((x) => ({ ...x })))
    expect(drawn().slice(0, 4)).toEqual(['# Downloading 3', 'Down one', 'Down two', 'Ghost'])
    expect(drawn()).not.toContain('# Not on this device 1')
  })

  it('moves a card whose state changed when nobody is in the list (control)', async () => {
    const { clock, drawn, rerender } = await mount()
    const paused = LIBRARY.map((x) => x.name === 'Down one' ? { ...x, state: 'paused' as const } : { ...x })
    await rerender(paused)
    clock.now += 3_000
    await rerender(paused.map((x) => ({ ...x })))
    expect(drawn().slice(0, 5)).toEqual(['# Downloading 1', 'Down two', '# Paused 2', 'Down one', 'Held'])
  })
})
