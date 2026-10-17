/** The volume and mute the viewer last left the player at, saved per origin like the normalizer switch. */
export const PLAYER_VOLUME_KEY = 'ripple:player-volume'

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
  const save = () => {
    // Before any click or key press on the page, a change is not the viewer's: the player mutes itself when autoplay
    // with sound is refused, and an embedder can write through the remote.
    if (!navigator.userActivation.hasBeenActive) return
    try { localStorage.setItem(PLAYER_VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted })) } catch {}
  }
  video.addEventListener('volumechange', save)
  return () => video.removeEventListener('volumechange', save)
}
