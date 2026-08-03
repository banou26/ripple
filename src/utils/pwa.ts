type InstallPromptEvent = Event & {
  readonly prompt: () => Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredInstall: InstallPromptEvent | null = null

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredInstall = event as InstallPromptEvent
  })
  window.addEventListener('appinstalled', () => { deferredInstall = null })
}

// %s is the placeholder the browser replaces with the encoded magnet link; the Home route reads it from ?magnet=
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
  const event = deferredInstall
  if (!event) return 'unavailable'
  // prompt() is single-use, so drop the reference before awaiting anything
  deferredInstall = null
  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome
  } catch {
    return 'unavailable'
  }
}

export type SetupOutcome = 'installed' | 'magnet-registered' | 'already-installed' | 'unsupported'

export const setupHandlers = async (): Promise<SetupOutcome> => {
  if (deferredInstall) {
    const outcome = await promptInstall()
    if (outcome === 'accepted') return 'installed'
  }
  if (registerMagnetHandler()) return 'magnet-registered'
  if (isAppInstalled()) return 'already-installed'
  return 'unsupported'
}
