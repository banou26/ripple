import type { PlayerMedia } from '@banou/media-player'

import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { MediaPlayer } from '@banou/media-player'

/**
 * Ripple renders a player it does not build: the store, its Provider and the chrome all live inside
 * @banou/media-player, and ripple imports no @videojs package at all. So what is worth testing here
 * is not the library's internals, which it owns and tests, but that this app can mount it and that
 * what it passes in arrives.
 *
 * `title` is the cheapest end-to-end signal available. It reaches the screen only through
 * `setSourceState`, which the store installs during `attach`, so it goes blank for any reason the
 * store fails to attach: a bad media shape, a broken build, or a second copy of the player store
 * getting between the two halves.
 */
const remoteMedia = (): PlayerMedia => {
  const target = new EventTarget()
  return Object.assign(target, {
    play: () => Promise.resolve(),
    pause: () => {},
    paused: true,
    currentTime: 0,
    duration: 600,
    seeking: false,
    src: 'test://media',
    currentSrc: 'test://media',
    readyState: 4,
    load: () => {},
    volume: 1,
    muted: false,
    playbackRate: 1,
    ended: false,
    error: null,
    buffered: { length: 1, start: () => 0, end: () => 600 },
    seekable: { length: 1, start: () => 0, end: () => 600 },
  }) as PlayerMedia
}

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 960px; height: 540px;'
  document.body.append(container)
  return { container }
}

describe('the player ripple embeds', () => {
  it('shares one store with the chrome, or nothing it is told ever shows', async () => {
    const screen = await render(
      <MediaPlayer media={remoteMedia()} title="One store" />,
      sized(),
    )
    await expect.element(screen.getByText('One store')).toBeInTheDocument()
  })

  it('drives the media it was handed', async () => {
    const media = remoteMedia()
    const played: string[] = []
    media.play = () => { played.push('play'); return Promise.resolve() }

    const screen = await render(<MediaPlayer media={media} />, sized())
    ;(screen.container.querySelector('button.play') as HTMLButtonElement).click()

    await expect.poll(() => played).toEqual(['play'])
  })
})
