// PWA handler setup. Two mechanisms, feature-detected at call time:
//  - magnet: links through navigator.registerProtocolHandler (Firefox and Chromium),
//  - .torrent file association, which rides on installing the app (Chromium only),
//    surfaced through the beforeinstallprompt event captured below.

type InstallPromptEvent = Event & {
  readonly prompt: () => Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// Chromium fires beforeinstallprompt when the app is installable. Capturing it lets
// the header button drive the install on a real user gesture instead of leaving the
// browser to surface a mini-infobar on its own schedule.
let deferredInstall: InstallPromptEvent | null = null

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredInstall = event as InstallPromptEvent
  })
  window.addEventListener('appinstalled', () => { deferredInstall = null })
}

// The registerProtocolHandler / file-handler URL. %s is the placeholder the browser
// replaces with the encoded magnet link; the Home route reads it from ?magnet=.
const magnetHandlerUrl = (): string => window.location.origin + '/?magnet=%s'

export const isAppInstalled = (): boolean =>
  (typeof window !== 'undefined' && Boolean(window.matchMedia?.('(display-mode: standalone)').matches)) ||
  (typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true)

const registerMagnetHandler = (): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.registerProtocolHandler !== 'function') return false
  try {
    navigator.registerProtocolHandler('magnet', magnetHandlerUrl())
    return true
  } catch {
    return false
  }
}

const promptInstall = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
  if (!deferredInstall) return 'unavailable'
  const event = deferredInstall
  await event.prompt()
  const { outcome } = await event.userChoice
  if (outcome === 'accepted') deferredInstall = null
  return outcome
}

export type SetupOutcome = 'installed' | 'magnet-registered' | 'already-installed' | 'unsupported'

// Best-effort across browsers: install when the browser offers it (which wires up
// both the .torrent and magnet handlers from the manifest on Chromium), otherwise
// register the magnet handler on its own so Firefox still routes magnet links here.
export const setupHandlers = async (): Promise<SetupOutcome> => {
  if (deferredInstall) {
    const outcome = await promptInstall()
    if (outcome === 'accepted') return 'installed'
  }
  if (registerMagnetHandler()) return 'magnet-registered'
  if (isAppInstalled()) return 'already-installed'
  return 'unsupported'
}
