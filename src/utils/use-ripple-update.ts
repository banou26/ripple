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
 *
 * A REFRESH TAKES THE UPDATE BY ITSELF, and the reason is the measurement below.
 */
export type RippleUpdate = {
  /** A newer build is installed and waiting for permission to take over. */
  ready: boolean
  /** Take it. Every open Ripple page reloads onto the new build. */
  update: () => void
}

/** Browsers check on navigation; a tab left open for hours needs asking. */
const POLL_MS = 15 * 60_000

/**
 * How long after a page load an update still counts as belonging to THIS navigation.
 *
 * MEASURED, on a Pages-like server (`max-age=0, must-revalidate`, the headers torrent.fkn.app
 * actually sends) with two real builds and a marker in the DOM: after a single refresh the document
 * is ALREADY running the new build's code, while the new worker sits in `waiting` and stays there
 * across further refreshes. So a refreshed page was showing "Update Ripple" while being the very
 * build the button offered, and no number of refreshes cleared it.
 *
 * That is what makes adopting safe HERE and nowhere else. The document, `/index.js` and `/sw.js` are
 * all revalidated by the same navigation, so a worker that installs in its wake belongs to the code
 * this page is already running. An update that turns up LATER does not: that page is running the old
 * build, and activating a worker under it deletes the cache generation its lazy chunks come from,
 * whose paths the deploy has since rotated away. That page gets the button, which is the whole
 * reason the button exists.
 *
 * Ten seconds is a slow install with room to spare. Past it the button appears instead, so the cost
 * of being wrong is one press.
 */
const ADOPT_WINDOW_MS = 10_000

/**
 * `adoptWindowMs` is the policy above, and it is an argument so a test can pin BOTH sides of it.
 * `performance.now()` counts from the document's own creation, which under a test runner is the
 * runner's page and always past any real window, so a test that could not set this could only ever
 * measure the half that asks.
 */
export const useRippleUpdate = (adoptWindowMs: number = ADOPT_WINDOW_MS): RippleUpdate => {
  const [ready, setReady] = useState(false)
  const waiting = useRef<ServiceWorker | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false
    /** Set while THIS page is the one asking, so the adoption does not also reload the page. */
    let adopting = false

    /**
     * Captured BEFORE anything can change it.
     *
     * `controllerchange` also fires the first time a worker ever claims this page, which is an
     * ordinary first visit and not an update. Reloading there would spend a page load on nothing and
     * look like a flicker on somebody's first ever visit. A page that already had a controller and
     * then gets a different one is the real thing.
     */
    const hadController = navigator.serviceWorker.controller !== null

    const onControllerChange = () => {
      /*
       * The adopting page does not reload, because it has nothing to reload ONTO: it is already
       * running the build the new worker belongs to. Every OTHER tab does, which is what the press
       * has always done and what carries a long-open tab onto the new build.
       */
      if (adopting) { adopting = false; look(); return }
      if (hadController) reloadPage()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let registration: ServiceWorkerRegistration | null = null
    const look = () => {
      if (cancelled || !registration) return
      const sw = registration.waiting
      waiting.current = sw
      // Inside the window this page adopts instead of asking, so the button never appears for an
      // update the refresh was already carrying.
      if (sw && performance.now() < adoptWindowMs) {
        adopting = true
        setReady(false)
        sw.postMessage({ type: 'take-over' })
        return
      }
      setReady(!!sw)
    }

    const watch = (r: ServiceWorkerRegistration) => {
      if (cancelled) return
      registration = r
      look()
      // an install in flight now: watch it reach `installed`, which is when it becomes waiting
      r.addEventListener('updatefound', () => {
        const installing = r.installing
        if (!installing) return
        installing.addEventListener('statechange', look)
      })
    }

    /*
     * There may be NO REGISTRATION YET, and that page has to end up watching too.
     *
     * index.tsx registers the worker on `load`, so on a first-ever visit this resolves undefined and
     * the old code returned, leaving that page with no `updatefound` listener for as long as it
     * stayed open. MEASURED with a fresh profile and a real second build: `updatefound` fired,
     * `registration.waiting` went true, and the button never appeared, which reads exactly like the
     * update never arriving. `ready` is the same registration once it has an active worker.
     */
    void navigator.serviceWorker.getRegistration().then((r) => {
      if (cancelled) return
      if (r) watch(r)
      else void navigator.serviceWorker.ready.then(watch)
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
  }, [adoptWindowMs])

  const update = useCallback(() => {
    const sw = waiting.current
    // No reload here. The reload happens in `controllerchange` above, in THIS tab and in every other
    // one, so all of them land on the new build together instead of this tab racing ahead.
    if (sw) sw.postMessage({ type: 'take-over' })
    else reloadPage()
  }, [])

  return { ready, update }
}
