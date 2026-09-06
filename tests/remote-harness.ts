// Loaded into the rig's embedder page by tests/embed-remote.spec.ts. Puts the one function the spec
// needs where `page.evaluate` can reach it.
import { mediaPlayer } from '@banou/media-player/remote'

declare global { interface Window { mediaPlayer: typeof mediaPlayer } }
window.mediaPlayer = mediaPlayer
