import { shell } from '@fkn/lib'
import { useEffect, useState } from 'react'

import { isFramed } from './framed'
import { pageWorkRunning } from './page-work'
import { reloadPage } from './reload'

/**
 * Ripple's update gate: a downloaded update is taken by itself at the first safe moment, and the page
 * reloads onto it. Mounted once for every route; true from the moment it goes, so the page can show
 * "Updating Ripple" until the reload.
 *
 * DUE when a newer worker is installed and waiting (an install only succeeds once every chunk is
 * cached, see sw.js), when another tab took one and this page's controller changed under it, or when
 * fkn.app's update was taken, which leaves this document on the old build under the new shell.
 *
 * SAFE at top level only (an embedded /watch or /download is reloaded by the page around it, never by
 * itself), online (the document is never cached, so a reload offline is the browser's error page),
 * with no video playing, no text field focused and no dialog open, and no page work (page-work.ts)
 * running in ANY Ripple page: taking the new worker over is what ends another page's save, since
 * Firefox ends the old worker's download streams the moment the new one activates. A due update looks
 * for that moment again every `recheckMs`. A worker found inside the adopt window is taken over
 * without a reload, under the same page work rule.
 *
 * GUARDED per tab (sessionStorage): at most two automatic reloads in five minutes. A refused reload
 * shows nothing and goes once the window has room.
 */
export type UpdateTiming = {
  /**
   * How long after a page load an update still counts as belonging to THIS navigation.
   *
   * MEASURED, on a Pages-like server (`max-age=0, must-revalidate`, the headers torrent.fkn.app
   * actually sends) with two real builds and a marker in the DOM: after a single refresh the document
   * is ALREADY running the new build's code, while the new worker sits in `waiting` and stays there
   * across further refreshes. So within this window the page adopts the waiting worker without a
   * reload: the document, `/index.js` and `/sw.js` are all revalidated by the same navigation, so a
   * worker that installs in its wake belongs to the code this page is already running. An update that
   * turns up LATER does not, so that page reloads: its own chunks stay cached only until the
   * activation after this one (sw.js).
   */
  adoptWindowMs: number
  /** How long the page waits for the taken worker's `controllerchange` before reloading anyway. */
  takeWaitMs: number
  /** How often a due update looks for its safe moment again. */
  recheckMs: number
}

export const UPDATE_TIMING: UpdateTiming = {
  adoptWindowMs: 10_000,
  // Chromium can drop a `skipWaiting()` activation when an event restarts the old worker mid-stop. The
  // document, index.js and sw.js are never cached, so a reload without it still runs the new code.
  takeWaitMs: 5_000,
  recheckMs: 1_000,
}

/** Browsers check on navigation; a tab left open for hours needs asking. */
const POLL_MS = 15 * 60_000

const RELOADS_KEY = 'ripple-update-reloads'
const RELOAD_LIMIT = 2
const RELOAD_WINDOW_MS = 5 * 60_000

/** Records an automatic reload and answers true, or answers false while the guard refuses one. */
const mayReload = (): boolean => {
  try {
    const now = Date.now()
    const recent = (JSON.parse(sessionStorage.getItem(RELOADS_KEY) ?? '[]') as number[])
      .filter((at) => now - at < RELOAD_WINDOW_MS)
    if (recent.length >= RELOAD_LIMIT) return false
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...recent, now]))
    return true
  } catch {
    // no record means no guard, and an unguarded reload can loop
    return false
  }
}

const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** A video playing, a field being typed in or a dialog open: what a reload would throw away in this page. */
const busy = (): boolean => {
  if ([...document.querySelectorAll('video')].some((video) => !video.paused && !video.ended)) return true
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true
  const focused = document.activeElement
  if (focused instanceof HTMLInputElement) return !NOT_TYPED.has(focused.type)
  return focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable)
}

/** Asks a waiting worker to take over; resolves on `controllerchange`, or after `waitMs` without one. */
const takeOver = (container: ServiceWorkerContainer, worker: ServiceWorker, waitMs: number): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      container.removeEventListener('controllerchange', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, waitMs)
    container.addEventListener('controllerchange', done)
    worker.postMessage({ type: 'take-over' })
  })

/**
 * `timing` is an argument so a test can pin both sides of the adopt window: `performance.now()`
 * counts from the document's own creation, which under a test runner is always past any real window.
 */
export const useRippleUpdate = (timing: UpdateTiming = UPDATE_TIMING): boolean => {
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    const container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null
    let cancelled = false
    let registration: ServiceWorkerRegistration | null = null
    /** Set from finding a worker to adopt until its `controllerchange`, so the adoption does not also reload. */
    let adopting = false
    /**
     * `controllerchange` also fires the first time a worker ever claims this page, which is an
     * ordinary first visit and not an update. A page that already had a controller and then gets a
     * different one is the real thing, and after that first claim every page has one.
     */
    let hadController = container !== null && container.controller !== null
    /** 'adopt' takes the waiting worker over without a reload, 'reload' takes it when there is one and reloads. */
    let next: 'adopt' | 'reload' | null = null
    let checking = false
    let going = false
    let recheck: number | undefined

    const go = async () => {
      going = true
      setUpdating(true)
      const waiting = registration?.waiting
      if (waiting && container) await takeOver(container, waiting, timing.takeWaitMs)
      if (!cancelled) reloadPage()
    }

    const check = async () => {
      if (cancelled || checking || going || next === null) return
      checking = true
      const held = await pageWorkRunning()
      checking = false
      if (cancelled || held) return
      if (next === 'adopt') {
        next = null
        window.clearInterval(recheck)
        recheck = undefined
        registration?.waiting?.postMessage({ type: 'take-over' })
      } else if (navigator.onLine && !busy() && mayReload()) void go()
    }

    const want = (action: 'adopt' | 'reload') => {
      if (cancelled || (action === 'reload' && isFramed())) return
      if (next !== 'reload') next = action
      recheck ??= window.setInterval(check, timing.recheckMs)
      void check()
    }

    const offShell = shell.onUpdateTaken(() => want('reload'))

    const look = () => {
      if (cancelled || !registration?.waiting) return
      if (performance.now() < timing.adoptWindowMs) {
        adopting = true
        want('adopt')
      } else want('reload')
    }

    const onControllerChange = () => {
      const had = hadController
      hadController = true
      if (adopting) {
        // this page's adoption, or another page taking the same worker first
        adopting = false
        look()
        return
      }
      if (had) want('reload')
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

    const poll = () => { void registration?.update().catch(() => {}) }
    const timer = window.setInterval(poll, POLL_MS)
    // coming back to a tab is exactly when somebody is about to use it, so ask then too
    const onVisible = () => { if (document.visibilityState === 'visible') poll() }

    if (container) {
      container.addEventListener('controllerchange', onControllerChange)
      document.addEventListener('visibilitychange', onVisible)
      /*
       * There may be NO REGISTRATION YET: index.tsx registers the worker on `load`, so on a first
       * visit this resolves undefined, and `ready` is the same registration once it has an active
       * worker. A page that gave up here watched nothing for as long as it stayed open.
       */
      void container.getRegistration().then((r) => {
        if (cancelled) return
        if (r) watch(r)
        else void container.ready.then(watch)
      })
    }

    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearInterval(recheck)
      document.removeEventListener('visibilitychange', onVisible)
      container?.removeEventListener('controllerchange', onControllerChange)
      offShell()
    }
  }, [timing])

  return updating
}
