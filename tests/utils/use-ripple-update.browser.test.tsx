/*
 * Ripple's update gate: when an update is due, when it is safe to take, and what guards the reload.
 *
 * `navigator.serviceWorker` is replaced rather than driven: these tests run in a real Chrome on
 * localhost, so the container is genuinely there and would answer about the runner's own worker.
 * The runner also puts every test in a frame, so `isFramed` is mocked, and the reload has its own
 * module because `location.reload` cannot be stubbed in a real browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import type { UpdateTiming } from '../../src/utils/use-ripple-update'

const reloaded = { count: 0 }
vi.mock('../../src/utils/reload', () => ({ reloadPage: () => { reloaded.count++ } }))

const framed = { value: false }
vi.mock('../../src/utils/framed', () => ({ isFramed: () => framed.value }))

const saves = { running: 0 }
vi.mock('../../src/torrent/save-file', () => ({ savesRunning: () => saves.running }))

/** the handler ripple hands to @fkn/lib for "fkn.app's update was taken", captured so a test can fire it */
const shellUpdate = { taken: null as (() => void) | null, unsubscribed: 0 }
vi.mock('@fkn/lib', () => ({
  shell: {
    onUpdateTaken: (handler: () => void) => {
      shellUpdate.taken = handler
      return () => { shellUpdate.unsubscribed++; shellUpdate.taken = null }
    },
  },
}))

// Mount's other imports, so it can be rendered on its own
vi.mock('../../src/router', () => ({ default: () => <div>a route</div> }))
vi.mock('../../src/torrent/client', () => ({ destroyTorrentClient: () => {} }))
vi.mock('../../src/torrent/engine-protocol', () => ({ hasWebLocks: () => true }))

type Listener = (event?: unknown) => void

/** `adoptWindowMs: 0` is past the window and `Infinity` inside it, whatever the runner's page age. */
const OPEN: UpdateTiming = { adoptWindowMs: 0, takeWaitMs: 300, recheckMs: 20 }
const LOADING: UpdateTiming = { ...OPEN, adoptWindowMs: Infinity }

const fakeContainer = (
  { waiting = null, controller = true, registeredYet = true }:
  { waiting?: unknown, controller?: boolean, registeredYet?: boolean } = {},
) => {
  const listeners: Record<string, Listener[]> = {}
  const fire = (type: string, event?: unknown) => { for (const cb of [...(listeners[type] ?? [])]) cb(event) }
  const regListeners: Record<string, Listener[]> = {}
  const registration = {
    waiting,
    installing: null as unknown,
    update: () => Promise.resolve(),
    addEventListener: (type: string, cb: Listener) => { (regListeners[type] ??= []).push(cb) },
  }
  // `ready` resolves only once a worker is active, which on a first-ever visit is after the page
  // has already asked `getRegistration()` and been told nothing
  let arrive = (_r: unknown) => {}
  const container = {
    controller: controller ? {} : null as unknown,
    addEventListener: (type: string, cb: Listener) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type: string, cb: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb)
    },
    getRegistration: () => Promise.resolve(registeredYet ? registration : undefined),
    ready: new Promise((resolve) => { arrive = resolve }),
  }
  if (registeredYet) arrive(registration)
  return {
    registration,
    /** A worker of build `build`, which answers `which-build` as sw.js does and records the rest. */
    worker: (build: string) => {
      const posted: { type: string }[] = []
      const own: Record<string, Listener[]> = {}
      const worker = {
        posted,
        takeOvers: () => posted.filter((m) => m.type === 'take-over').length,
        postMessage: (data: { type: string }) => {
          posted.push(data)
          if (data.type === 'which-build') queueMicrotask(() => fire('message', { source: worker, data: { type: 'build', build } }))
        },
        addEventListener: (type: string, cb: Listener) => { (own[type] ??= []).push(cb) },
        fire: (type: string) => { for (const cb of own[type] ?? []) cb() },
      }
      return worker
    },
    /** what the browser fires once a worker calls skipWaiting and claims this page */
    controllerChange: (to: unknown = {}) => {
      registration.waiting = null
      container.controller = to
      fire('controllerchange')
    },
    /** an install that lands while the page is already open */
    installs: (worker: { fire: (type: string) => void }) => {
      registration.installing = worker
      for (const cb of regListeners.updatefound ?? []) cb()
      registration.installing = null
      registration.waiting = worker
      worker.fire('statechange')
    },
    install: () => {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
    },
    /** index.tsx registers on `load`, so this is the moment that page finally has a registration */
    registers: () => arrive(registration),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  reloaded.count = 0
  framed.value = false
  saves.running = 0
  sessionStorage.clear()
  for (const video of document.querySelectorAll('video')) video.remove()
  // the own property shadows the real container; deleting it hands the real one back
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
})

const mount = async (timing: UpdateTiming) => {
  const { useRippleUpdate } = await import('../../src/utils/use-ripple-update')
  const Probe = () => <div>{useRippleUpdate(timing) ? 'Updating Ripple' : 'idle'}</div>
  return render(<Probe />)
}

/** A worker that installs while the page sits open, past the adopt window. */
const openWithUpdate = async (build = 'b2') => {
  const sw = fakeContainer()
  sw.install()
  const screen = await mount(OPEN)
  await expect.poll(() => screen.container.textContent).toBe('idle')
  const worker = sw.worker(build)
  sw.installs(worker)
  return { sw, screen, worker }
}

describe('a refresh that lands on a new build', () => {
  it('adopts the waiting worker without a reload or a label', async () => {
    const sw = fakeContainer()
    const worker = sw.worker('b2')
    sw.registration.waiting = worker
    sw.install()

    const screen = await mount(LOADING)
    await expect.poll(() => worker.takeOvers()).toBe(1)
    sw.controllerChange()
    await sleep(100)
    expect(screen.container.textContent).toBe('idle')
    expect(reloaded.count, 'the page reloaded onto the build it was already running').toBe(0)
  })
})

describe('an update that arrives while the page sits open', () => {
  it('shows the label, takes the worker, and reloads once it has taken over', async () => {
    const { sw, screen, worker } = await openWithUpdate()
    await expect.poll(() => worker.takeOvers()).toBe(1)
    await expect.poll(() => screen.container.textContent).toBe('Updating Ripple')
    expect(reloaded.count, 'reloaded before the new worker took over').toBe(0)
    sw.controllerChange()
    await expect.poll(() => reloaded.count).toBe(1)
    await sleep(400)
    expect(reloaded.count).toBe(1)
  })

  /** A dropped activation must not leave the label up for good: the document is never cached. */
  it('reloads anyway when the taken worker never takes over', async () => {
    const { worker } = await openWithUpdate()
    await expect.poll(() => worker.takeOvers()).toBe(1)
    await sleep(OPEN.takeWaitMs / 2)
    expect(reloaded.count).toBe(0)
    await expect.poll(() => reloaded.count, { timeout: 2000 }).toBe(1)
  })

  it('waits for a save to disk to end', async () => {
    saves.running = 1
    const { sw, screen, worker } = await openWithUpdate()
    await sleep(200)
    expect(worker.takeOvers(), 'took the update under a running save').toBe(0)
    expect(screen.container.textContent).toBe('idle')

    saves.running = 0
    await expect.poll(() => worker.takeOvers()).toBe(1)
    sw.controllerChange()
    await expect.poll(() => reloaded.count).toBe(1)
  })

  it('waits for a playing video to pause', async () => {
    const video = document.body.appendChild(document.createElement('video'))
    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    const { sw, worker } = await openWithUpdate()
    await sleep(200)
    expect(worker.takeOvers(), 'took the update under a playing video').toBe(0)

    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    await expect.poll(() => worker.takeOvers()).toBe(1)
    sw.controllerChange()
    await expect.poll(() => reloaded.count).toBe(1)
  })

  /** An embedded /watch or /download reloads with the page around it, never on its own. */
  it('never reloads a framed page', async () => {
    framed.value = true
    const { sw, screen, worker } = await openWithUpdate()
    sw.controllerChange()
    shellUpdate.taken?.()
    await sleep(400)
    expect(worker.takeOvers()).toBe(0)
    expect(reloaded.count).toBe(0)
    expect(screen.container.textContent).toBe('idle')
  })
})

describe('another tab taking the update', () => {
  it('reloads this one at its own safe moment', async () => {
    saves.running = 1
    const sw = fakeContainer()
    sw.install()
    const screen = await mount(OPEN)
    await expect.poll(() => screen.container.textContent).toBe('idle')

    sw.controllerChange(sw.worker('b2'))
    await sleep(200)
    expect(reloaded.count, 'reloaded under a running save').toBe(0)
    saves.running = 0
    await expect.poll(() => reloaded.count).toBe(1)
    await expect.poll(() => screen.container.textContent).toBe('Updating Ripple')
  })

  /** A first visit's page gets its controller from the first claim, which is not an update. */
  it('reloads a first visit\'s tab on a later update, once the first claim gave it a controller', async () => {
    const sw = fakeContainer({ controller: false })
    sw.install()
    await mount(OPEN)
    sw.controllerChange()
    await sleep(200)
    expect(reloaded.count, 'the first claim reloaded the page').toBe(0)

    sw.controllerChange(sw.worker('b2'))
    await expect.poll(() => reloaded.count).toBe(1)
  })

  /** Only home listened before the gate moved to Mount, so a /legal tab kept the old build. */
  it('reloads a page on any route', async () => {
    const sw = fakeContainer()
    sw.install()
    const { default: Mount } = await import('../../src/components/mount')
    const screen = await render(<Mount/>)
    await expect.poll(() => screen.container.textContent).toContain('a route')

    sw.controllerChange(sw.worker('b2'))
    await expect.poll(() => reloaded.count).toBe(1)
    await expect.poll(() => document.body.textContent).toContain('Updating Ripple')
  })
})

describe('fkn.app\'s update taken', () => {
  it('reloads at the safe moment rather than at once', async () => {
    const sw = fakeContainer()
    sw.install()
    const video = document.body.appendChild(document.createElement('video'))
    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    await mount(OPEN)
    await expect.poll(() => shellUpdate.taken).not.toBeNull()

    shellUpdate.taken!()
    await sleep(200)
    expect(reloaded.count, 'reloaded under a playing video').toBe(0)
    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    await expect.poll(() => reloaded.count).toBe(1)
  })

  it('lets go of the handler when the page unmounts, which hands the lib its default back', async () => {
    fakeContainer().install()
    const screen = await mount(OPEN)
    await expect.poll(() => shellUpdate.taken).not.toBeNull()
    const before = shellUpdate.unsubscribed
    screen.unmount()
    expect(shellUpdate.unsubscribed).toBe(before + 1)
  })
})

describe('the loop guard', () => {
  it('refuses a third automatic reload within five minutes, and shows nothing', async () => {
    const now = Date.now()
    sessionStorage.setItem('ripple-update-reloads', JSON.stringify([{ at: now - 60_000 }, { at: now - 1000, build: 'b1' }]))
    const { screen, worker } = await openWithUpdate('b2')
    await sleep(300)
    expect(worker.takeOvers()).toBe(0)
    expect(reloaded.count).toBe(0)
    expect(screen.container.textContent).toBe('idle')
  })

  it('refuses a second reload onto the same build', async () => {
    sessionStorage.setItem('ripple-update-reloads', JSON.stringify([{ at: Date.now() - 3_600_000, build: 'b2' }]))
    const { worker } = await openWithUpdate('b2')
    await sleep(300)
    expect(worker.takeOvers()).toBe(0)
    expect(reloaded.count).toBe(0)
  })

  it('allows a reload onto a build it has not reloaded onto, and records it', async () => {
    sessionStorage.setItem('ripple-update-reloads', JSON.stringify([{ at: Date.now() - 3_600_000, build: 'b1' }]))
    const { sw, worker } = await openWithUpdate('b2')
    await expect.poll(() => worker.takeOvers()).toBe(1)
    sw.controllerChange()
    await expect.poll(() => reloaded.count).toBe(1)
    const builds = (JSON.parse(sessionStorage.getItem('ripple-update-reloads') ?? '[]') as { build?: string }[]).map((r) => r.build)
    expect(builds).toEqual(['b1', 'b2'])
  })
})

/**
 * A FIRST-EVER VISIT has no registration when the page asks for one: index.tsx registers the worker
 * on `load`, after this effect has already run, so the page has to wait for `ready`.
 */
it('watches a registration that only exists after the first look', async () => {
  const sw = fakeContainer({ registeredYet: false })
  sw.install()
  await mount(OPEN)

  sw.registers()
  const worker = sw.worker('b2')
  sw.installs(worker)
  await expect.poll(() => worker.takeOvers()).toBe(1)
})
