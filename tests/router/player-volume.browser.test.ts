import { afterEach, describe, expect, it, vi } from 'vitest'

import { PLAYER_VOLUME_KEY, keepPlayerVolume } from '../../src/router/player-volume'

const saved = () => JSON.parse(localStorage.getItem(PLAYER_VOLUME_KEY) ?? 'null')

// volumechange is dispatched from a queued task, so a write is only seen once the event has run
const change = async (video: HTMLVideoElement, write: () => void) => {
  const changed = new Promise((resolve) => video.addEventListener('volumechange', resolve, { once: true }))
  write()
  await changed
}

describe('the kept player volume', () => {
  afterEach(() => {
    localStorage.removeItem(PLAYER_VOLUME_KEY)
    vi.restoreAllMocks()
  })

  it('puts the saved volume and mute on the video', () => {
    localStorage.setItem(PLAYER_VOLUME_KEY, JSON.stringify({ volume: 0.3, muted: true }))
    const video = document.createElement('video')
    keepPlayerVolume(video)
    expect(video.volume).toBe(0.3)
    expect(video.muted).toBe(true)
  })

  it('saves every change to the video until it is stopped', async () => {
    const video = document.createElement('video')
    const stop = keepPlayerVolume(video)
    expect(saved()).toBeNull()

    await change(video, () => { video.volume = 0.5 })
    expect(saved()).toEqual({ volume: 0.5, muted: false })
    await change(video, () => { video.muted = true })
    expect(saved()).toEqual({ volume: 0.5, muted: true })

    stop()
    await change(video, () => { video.volume = 0.2 })
    expect(saved()).toEqual({ volume: 0.5, muted: true })
  })

  it('applies nothing from a saved value it cannot use', () => {
    for (const value of ['{"volume":2,"muted":false}', '{"volume":0.3}', '{"volume":"0.3","muted":true}', 'null', '5', '{']) {
      localStorage.setItem(PLAYER_VOLUME_KEY, value)
      const video = document.createElement('video')
      keepPlayerVolume(video)
      expect([value, video.volume, video.muted]).toEqual([value, 1, false])
    }
  })

  it('plays at the defaults, and keeps playing, where storage is blocked', async () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => { errors.push(event.error) }
    window.addEventListener('error', onError)

    const video = document.createElement('video')
    keepPlayerVolume(video)
    expect([video.volume, video.muted]).toEqual([1, false])
    await change(video, () => { video.volume = 0.4 })
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
  })
})
