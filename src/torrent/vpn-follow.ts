export type VpnFollowing = {
  /** What the stored choice asks for now. */
  wanted: () => boolean
  /** Whether the engine this page runs was started behind the relay, or null when this page runs none. */
  running: () => boolean | null
  /** Whether a page is saving a file, which a new engine would end. */
  busy: () => Promise<boolean>
  /** Lets the engine write its resume data, for as long as the caller allows. */
  flush: () => Promise<unknown>
  /** Replaces this page's engine with one started on the stored choice. */
  restart: () => void | Promise<void>
}

/**
 * Keeps this page's engine on the transport the stored choice of the VPN asks for.
 *
 * The engine is replaced, never switched: it waits while a page saves a file, lets the engine write its resume
 * data, and starts another. One change runs at a time and the choice is read again at every step, so any number of
 * changes end on the last one, with one engine. A page that runs no engine does nothing: the page that does hears
 * of the choice itself.
 *
 * Returns the function to call when the choice may have changed. It resolves once the engine is on the choice.
 */
export const vpnFollower = ({ wanted, running, busy, flush, restart }: VpnFollowing, pollMs = 1_000) => {
  let following: Promise<void> | null = null
  const differs = () => {
    const onVpn = running()
    return onVpn !== null && onVpn !== wanted()
  }
  const run = async () => {
    while (differs()) {
      if (await busy()) { await new Promise((resolve) => setTimeout(resolve, pollMs)); continue }
      await flush().catch(() => {})
      if (differs()) await restart()
    }
  }
  return (): Promise<void> => following ??= run().finally(() => { following = null })
}
