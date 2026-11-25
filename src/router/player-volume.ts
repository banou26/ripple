import { PLAYER_VOLUME_KEY } from '../torrent/constants'
import { onSettingApplied, recordSetting } from '../torrent/settings-sync'

/** The volume and mute the viewer last left the player at, saved locally and synced per signed-in account. */
export { PLAYER_VOLUME_KEY }

const SYNC_DEBOUNCE_MS = 400

/**
 * Puts the saved volume and mute on the player's video and saves each change made once the viewer has used the
 * page, until the returned function is called. Nothing is applied when the saved value is unusable or storage
 * cannot be read.
 */
export const keepPlayerVolume = (video: HTMLMediaElement) => {
  try {
    const { volume, muted } = JSON.parse(localStorage.getItem(PLAYER_VOLUME_KEY) ?? '{}')
    // an out-of-range volume throws in its setter, before muted is written
    if (typeof volume === 'number' && typeof muted === 'boolean') Object.assign(video, { volume, muted })
  } catch {}
  let applying: { volume: number, muted: boolean } | null = null
  let applyingCount = 0
  let pending: { volume: number, muted: boolean } | null = null
  let timer: number | undefined

  const offApplied = onSettingApplied('playerVolume', (next) => {
    const count = (video.volume !== next.volume ? 1 : 0) + (video.muted !== next.muted ? 1 : 0)
    if (count === 0) return
    pending = null
    window.clearTimeout(timer)
    applying = next
    applyingCount = count
    try { Object.assign(video, next) } catch { applying = null; applyingCount = 0 }
  })

  const save = () => {
    if (applying && applyingCount > 0 && video.volume === applying.volume && video.muted === applying.muted) {
      applyingCount -= 1
      if (applyingCount === 0) applying = null
      return
    }
    applying = null
    applyingCount = 0
    // Before any click or key press on the page, a change is not the viewer's: the player mutes itself when autoplay
    // with sound is refused, and an embedder can write through the remote.
    if (!navigator.userActivation.hasBeenActive) return
    const next = { volume: video.volume, muted: video.muted }
    try { localStorage.setItem(PLAYER_VOLUME_KEY, JSON.stringify(next)) } catch {}
    pending = next
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (!pending) return
      const flush = pending
      pending = null
      void recordSetting('playerVolume', flush)
    }, SYNC_DEBOUNCE_MS)
  }
  video.addEventListener('volumechange', save)
  return () => {
    video.removeEventListener('volumechange', save)
    offApplied()
    window.clearTimeout(timer)
    if (pending) {
      const flush = pending
      pending = null
      void recordSetting('playerVolume', flush)
    }
  }
}
