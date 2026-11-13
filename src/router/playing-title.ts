import { useEffect } from 'react'

import { isFramed } from '../utils/framed'

/**
 * Names the file playing in the tab's title, as `<name> · <the page's own title>`, and as the Media Session's title,
 * while `name` is set. Both are handed back when the name changes or the player goes. A frame sets neither: its title
 * shows nowhere, and Chrome's media controls for the embedder's tab read the Media Session of the frame holding the
 * player, where this would replace the embedder's own title.
 */
export const usePlayingTitle = (name: string | undefined) => {
  useEffect(() => {
    if (!name || isFramed()) return
    const ordinary = document.title
    document.title = `${name} · ${ordinary}`
    const session = 'mediaSession' in navigator ? navigator.mediaSession : null
    if (session) session.metadata = new MediaMetadata({ title: name })
    return () => {
      document.title = ordinary
      if (session) session.metadata = null
    }
  }, [name])
}
