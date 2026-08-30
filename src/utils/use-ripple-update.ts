import { useCallback, useEffect, useRef, useState } from 'react'

import { reloadPage } from './reload'

/**
 * Whether a newer Ripple is installed and waiting, and the one call that takes it.
 *
 * The worker no longer calls `skipWaiting()` on install, so a new build installs quietly and sits in
 * `waiting` while every open page keeps the build it loaded with. That is what makes an update
 * something the person chooses rather than something that happens under a running download.
 *
 * ONE PRESS RELOADS EVERY TAB, and not because the pressing tab tells the others. It asks the
 * waiting worker to take over; taking over fires `controllerchange` in every client of the origin,
 * and each one reloads itself. No message passing, no tab registry, and it reaches tabs this one has
 * never heard of.
 */
export type RippleUpdate = {
  /** A newer build is installed and waiting for permission to take over. */
  ready: boolean
  /** Take it. Every open Ripple page reloads onto the new build. */
  update: () => void
}

/** Browsers check on navigation; a tab left open for hours needs asking. */
const POLL_MS = 15 * 60_000

export const useRippleUpdate = (): RippleUpdate => {
  const [ready, setReady] = useState(false)
  const waiting = useRef<ServiceWorker | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false

    /**
     * Captured BEFORE anything can change it.
     *
     * `controllerchange` also fires the first time a worker ever claims this page, which is an
     * ordinary first visit and not an update. Reloading there would spend a page load on nothing and
     * look like a flicker on somebody's first ever visit. A page that already had a controller and
     * then gets a different one is the real thing.
     */
    const hadController = navigator.serviceWorker.controller !== null

    const onControllerChange = () => { if (hadController) reloadPage() }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let registration: ServiceWorkerRegistration | null = null
    const look = () => {
      if (cancelled || !registration) return
      waiting.current = registration.waiting
      setReady(!!registration.waiting)
    }

    void navigator.serviceWorker.getRegistration().then((r) => {
      if (cancelled || !r) return
      registration = r
      look()
      // an install in flight now: watch it reach `installed`, which is when it becomes waiting
      r.addEventListener('updatefound', () => {
        const installing = r.installing
        if (!installing) return
        installing.addEventListener('statechange', look)
      })
    })

    const poll = () => { void registration?.update().catch(() => {}) }
    const timer = window.setInterval(poll, POLL_MS)
    // coming back to a tab is exactly when somebody is about to use it, so ask then too
    const onVisible = () => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  const update = useCallback(() => {
    const sw = waiting.current
    // No reload here. The reload happens in `controllerchange` above, in THIS tab and in every other
    // one, so all of them land on the new build together instead of this tab racing ahead.
    if (sw) sw.postMessage({ type: 'take-over' })
    else reloadPage()
  }, [])

  return { ready, update }
}
