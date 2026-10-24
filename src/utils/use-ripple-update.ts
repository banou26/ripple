import { shell } from '@fkn/lib'
import { useEffect, useState } from 'react'

import { savesRunning } from '../torrent/save-file'
import { isFramed } from './framed'
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
 * itself), with no save to disk running (the page writes it, so a reload cuts the file off) and no
 * video playing. A due update looks for that moment again every `recheckMs`.
 *
 * GUARDED per tab (sessionStorage): at most two automatic reloads in five minutes, and one onto any
 * given build. A refused reload does nothing visible.
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
  // Chromium can drop a `skipWaiting()` activation (the fkn.app lesson of 2026-10-08). The document,
  // index.js and sw.js are never cached, so a reload without it still runs the new code and adopts.
  takeWaitMs: 5_000,
  recheckMs: 1_000,
}

/** Browsers check on navigation; a tab left open for hours needs asking. */
const POLL_MS = 15 * 60_000

const BUILD_ASK_MS = 1_000

const RELOADS_KEY = 'ripple-update-reloads'
const RELOAD_LIMIT = 2
const RELOAD_WINDOW_MS = 5 * 60_000

type Reload = { at: number, build?: string }

/** Records an automatic reload and answers true, or answers false when the guard refuses it. */
const mayReload = (build: string | undefined): boolean => {
  try {
    const now = Date.now()
    const past = JSON.parse(sessionStorage.getItem(RELOADS_KEY) ?? '[]') as Reload[]
    if (past.filter((reload) => now - reload.at < RELOAD_WINDOW_MS).length >= RELOAD_LIMIT) return false
    if (build !== undefined && past.some((reload) => reload.build === build)) return false
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify([...past, { at: now, build }]))
    return true
  } catch {
    // no record means no guard, and an unguarded reload can loop
    return false
  }
}

const playing = (): boolean => [...document.querySelectorAll('video')].some((video) => !video.paused && !video.ended)

/** The build a worker reports (`which-build` in sw.js), or undefined when it does not answer in time. */
const buildOf = (container: ServiceWorkerContainer, worker: ServiceWorker | null): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (!worker) { resolve(undefined); return }
    const done = (build?: string) => {
      container.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(build)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source === worker && event.data?.type === 'build') done(String(event.data.build))
    }
    const timer = setTimeout(done, BUILD_ASK_MS)
    container.addEventListener('message', onMessage)
    worker.postMessage({ type: 'which-build' })
  })

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
    /** Set while THIS page adopts at load, so the adoption does not also reload it. */
    let adopting = false
    /**
     * `controllerchange` also fires the first time a worker ever claims this page, which is an
     * ordinary first visit and not an update. A page that already had a controller and then gets a
     * different one is the real thing, and after that first claim every page has one.
     */
    let hadController = container !== null && container.controller !== null
    /** 'ripple' when this app's own build moved, 'fkn' when only fkn.app's did. */
    let due: 'ripple' | 'fkn' | null = null
    let going = false
    let recheck: number | undefined

    const go = async () => {
      going = true
      window.clearInterval(recheck)
      recheck = undefined
      const waiting = registration?.waiting ?? null
      const build = due === 'ripple' && container ? await buildOf(container, waiting ?? container.controller) : undefined
      if (cancelled) return
      if (!mayReload(build)) { going = false; due = null; return }
      setUpdating(true)
      if (waiting && container) await takeOver(container, waiting, timing.takeWaitMs)
      if (!cancelled) reloadPage()
    }

    const check = () => {
      if (cancelled || going || due === null || savesRunning() > 0 || playing()) return
      void go()
    }

    const markDue = (reason: 'ripple' | 'fkn') => {
      if (cancelled || going || isFramed()) return
      if (due !== 'ripple') due = reason
      recheck ??= window.setInterval(check, timing.recheckMs)
      check()
    }

    const offShell = shell.onUpdateTaken(() => markDue('fkn'))

    const look = () => {
      const waiting = registration?.waiting
      if (cancelled || !waiting) return
      if (performance.now() < timing.adoptWindowMs) {
        adopting = true
        waiting.postMessage({ type: 'take-over' })
        return
      }
      markDue('ripple')
    }

    const onControllerChange = () => {
      const had = hadController
      hadController = true
      if (going) return
      if (adopting) { adopting = false; look(); return }
      if (had) markDue('ripple')
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
