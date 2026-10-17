/** The volume and mute the viewer last left the player at, saved per origin like the normalizer switch. */
export const PLAYER_VOLUME_KEY = 'ripple:player-volume'

/**
 * Puts the saved volume and mute on the player's video and saves every change to it, until the returned function
 * is called. Nothing is applied when the saved value is unusable or storage cannot be read.
 */
export const keepPlayerVolume = (video: HTMLMediaElement) => {
  try {
    const { volume, muted } = JSON.parse(localStorage.getItem(PLAYER_VOLUME_KEY) ?? '{}')
    if (typeof volume === 'number' && volume >= 0 && volume <= 1 && typeof muted === 'boolean') {
      Object.assign(video, { volume, muted })
    }
  } catch {}
  const save = () => {
    try { localStorage.setItem(PLAYER_VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted })) } catch {}
  }
  video.addEventListener('volumechange', save)
  return () => video.removeEventListener('volumechange', save)
}
