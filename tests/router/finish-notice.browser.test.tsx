import type { Torrent } from '../../src/torrent/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { finishes, useFinishNotice } from '../../src/router/finish-notice'
import { OK } from '../../src/theme'

/** The runner puts every test in a frame, which the hook reads as fkn.app's. */
const framed = { value: false }
vi.mock('../../src/utils/framed', () => ({ isFramed: () => framed.value }))

const TITLE = 'Ripple Torrent'

const row = (name: string, state: Torrent['state'], over: Partial<Torrent> = {}): Torrent => ({
  id: name, magnet: `magnet:?xt=urn:btih:${name}`, infoHash: name, name, size: 1, downloaded: 0,
  progress: state === 'seeding' || state === 'completed' ? 1 : 0.5, state, down: 0, up: 0, peers: 0, seeds: 0,
  eta: '-', flags: 0, queuePosition: -1, stats: null, ...over,
})

const Probe = ({ torrents }: { torrents: Torrent[] }) => { useFinishNotice(torrents); return null }

const show = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A blue square, as the page's icon. */
const blueIcon = () => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 16
  const pen = canvas.getContext('2d')!
  pen.fillStyle = '#0000ff'
  pen.fillRect(0, 0, 16, 16)
  return canvas.toDataURL('image/png')
}

const pixels = async (url: string, points: [number, number][]) => {
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const pen = canvas.getContext('2d')!
  pen.drawImage(image, 0, 0)
  return points.map(([x, y]) => [...pen.getImageData(x, y, 1, 1).data.slice(0, 3)])
}

const hex = (color: string) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))

let icon: HTMLLinkElement
let ordinaryIcon: string
let badge: ReturnType<typeof vi.fn>
let cleared: ReturnType<typeof vi.fn>

beforeEach(() => {
  framed.value = false
  document.title = TITLE
  for (const link of document.querySelectorAll('link[rel~="icon"]')) link.remove()
  ordinaryIcon = blueIcon()
  icon = document.head.appendChild(document.createElement('link'))
  icon.rel = 'shortcut icon'
  icon.setAttribute('href', ordinaryIcon)
  badge = vi.fn(() => Promise.resolve())
  cleared = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: badge })
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: cleared })
})

afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState
  delete (navigator as { setAppBadge?: unknown }).setAppBadge
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge
  icon.remove()
})

describe('the count of downloads finished while the tab is hidden', () => {
  it('shows in the title, on the icon and as the badge, and all three go once the tab is seen again', async () => {
    const screen = await render(<Probe torrents={[row('a', 'downloading'), row('b', 'retrying'), row('c', 'downloading')]}/>)
    show('hidden')
    await screen.rerender(<Probe torrents={[row('a', 'seeding'), row('b', 'retrying'), row('c', 'downloading')]}/>)
    await expect.poll(() => document.title).toBe(`(1) ${TITLE}`)
    expect(badge).toHaveBeenLastCalledWith(1)
    await expect.poll(() => icon.getAttribute('href') !== ordinaryIcon).toBe(true)
    expect(icon.getAttribute('href')).toMatch(/^data:image\/png/)
    const [corner, dot] = await pixels(icon.href, [[4, 60], [48, 16]])
    expect(corner, 'the icon itself, under the dot').toEqual(hex('#0000ff'))
    expect(dot, 'the dot').toEqual(hex(OK))

    await screen.rerender(<Probe torrents={[row('a', 'seeding'), row('b', 'completed'), row('c', 'downloading')]}/>)
    await expect.poll(() => document.title).toBe(`(2) ${TITLE}`)
    expect(badge).toHaveBeenLastCalledWith(2)

    show('visible')
    await expect.poll(() => document.title).toBe(TITLE)
    expect(badge).toHaveBeenCalledTimes(2)
    expect(cleared.mock.invocationCallOrder.at(-1), 'the badge cleared after it was last set').toBeGreaterThan(badge.mock.invocationCallOrder.at(-1)!)
    expect(icon.getAttribute('href'), 'the icon as it was, exactly').toBe(ordinaryIcon)
  })

  it('counts nothing that finishes while the tab is shown', async () => {
    show('visible')
    const screen = await render(<Probe torrents={[row('a', 'downloading')]}/>)
    await screen.rerender(<Probe torrents={[row('a', 'seeding')]}/>)
    show('hidden')
    await screen.rerender(<Probe torrents={[row('a', 'seeding'), row('b', 'downloading')]}/>)
    await screen.rerender(<Probe torrents={[row('a', 'seeding'), row('b', 'seeding')]}/>)
    await expect.poll(() => document.title).toBe(`(1) ${TITLE}`)
  })

  it('does nothing inside a frame, where the title and the icon are the page\'s around it', async () => {
    framed.value = true
    show('hidden')
    const screen = await render(<Probe torrents={[row('a', 'downloading')]}/>)
    await screen.rerender(<Probe torrents={[row('a', 'seeding')]}/>)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(document.title).toBe(TITLE)
    expect(badge).not.toHaveBeenCalled()
    expect(icon.getAttribute('href')).toBe(ordinaryIcon)
  })

  it('takes a badge the browser refuses in its stride', async () => {
    const refused = (event: PromiseRejectionEvent) => { unhandled.push(event.reason) }
    const unhandled: unknown[] = []
    window.addEventListener('unhandledrejection', refused)
    // plain functions: a vi.fn handles the promises it returns, to record how they settled
    const asked: string[] = []
    const refuse = (what: string) => () => { asked.push(what); return Promise.reject(new DOMException('refused', 'NotAllowedError')) }
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: refuse('set') })
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: refuse('clear') })
    try {
      show('hidden')
      const screen = await render(<Probe torrents={[row('a', 'downloading')]}/>)
      await screen.rerender(<Probe torrents={[row('a', 'seeding')]}/>)
      await expect.poll(() => document.title).toBe(`(1) ${TITLE}`)
      show('visible')
      await expect.poll(() => document.title).toBe(TITLE)
      expect(asked).toEqual(['set', 'clear'])
      // a rejection nobody handled is reported a task after it settles
      await new Promise((resolve) => setTimeout(resolve))
      expect(unhandled).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', refused)
    }
  })

  it('leaves the icon as it was when the tab is seen before the dotted copy could be drawn', async () => {
    const images: HTMLImageElement[] = []
    let decoded = () => {}
    const Real = window.Image
    vi.stubGlobal('Image', function () {
      const image = new Real()
      images.push(image)
      Object.defineProperty(image, 'onload', { set: (draw: () => void) => { decoded = () => draw.call(image) } })
      return image
    })
    try {
      show('hidden')
      const screen = await render(<Probe torrents={[row('a', 'downloading')]}/>)
      await screen.rerender(<Probe torrents={[row('a', 'seeding')]}/>)
      await expect.poll(() => document.title).toBe(`(1) ${TITLE}`)
      show('visible')
      await expect.poll(() => document.title).toBe(TITLE)
      await images[0]!.decode()
      decoded()
      expect(icon.getAttribute('href')).toBe(ordinaryIcon)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still counts where the browser has no badge', async () => {
    delete (navigator as { setAppBadge?: unknown }).setAppBadge
    const own = Object.getOwnPropertyDescriptor(Navigator.prototype, 'setAppBadge')
    if (own) delete (Navigator.prototype as { setAppBadge?: unknown }).setAppBadge
    try {
      expect('setAppBadge' in navigator).toBe(false)
      show('hidden')
      const screen = await render(<Probe torrents={[row('a', 'downloading')]}/>)
      await screen.rerender(<Probe torrents={[row('a', 'seeding')]}/>)
      await expect.poll(() => document.title).toBe(`(1) ${TITLE}`)
      show('visible')
      await expect.poll(() => document.title).toBe(TITLE)
    } finally {
      if (own) Object.defineProperty(Navigator.prototype, 'setAppBadge', own)
    }
  })
})

describe('what counts as a finished download', () => {
  it('is a torrent the person added, seen downloading and then finished', () => {
    const first = finishes(new Set(), [row('a', 'downloading'), row('b', 'retrying'), row('c', 'paused')])
    expect(first.count).toBe(0)
    const second = finishes(first.seen, [row('a', 'seeding'), row('b', 'completed'), row('c', 'seeding')])
    expect(second.count, 'a and b, and not c, never seen downloading').toBe(2)
    expect(finishes(second.seen, [row('a', 'seeding'), row('b', 'completed')]).count, 'each once').toBe(0)
  })

  it('is kept through a pause, and through the engine moving to another tab', () => {
    let { seen } = finishes(new Set(), [row('a', 'downloading')])
    for (const state of ['paused', 'starting', 'checking', 'downloading'] as const) seen = finishes(seen, [row('a', state)]).seen
    expect(finishes(seen, [row('a', 'seeding')]).count).toBe(1)
  })

  it('is never a temporary torrent, nor a library starting up already finished', () => {
    const temporary = { ephemeral: true }
    const first = finishes(new Set(), [row('t', 'downloading', temporary), row('s', 'starting'), row('k', 'checking')])
    expect(finishes(first.seen, [row('t', 'seeding', temporary), row('s', 'seeding'), row('k', 'seeding')]).count).toBe(0)
  })
})
