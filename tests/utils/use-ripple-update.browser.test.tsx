/*
 * Which of the two things a waiting worker means, and the page's answer to each.
 *
 * A refresh that lands on a new build ADOPTS it silently: measured against two real builds, the
 * document is already running the new code by then, so asking would be asking about the build the
 * person is looking at. An update that arrives while the page sits open is the opposite case, and
 * that one gets the button, because activating there pulls the cache generation out from under code
 * that is still running.
 *
 * `navigator.serviceWorker` is replaced rather than driven: these tests run in a real Chrome on
 * localhost, so the container is genuinely there and would answer about the runner's own worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

const reloaded = { count: 0 }
vi.mock('../../src/utils/reload', () => ({ reloadPage: () => { reloaded.count++ } }))

type Listener = () => void

/** A worker that records what the page says to it, which is the whole of the take-over protocol. */
const fakeWorker = () => {
  const posted: unknown[] = []
  const listeners: Record<string, Listener[]> = {}
  return {
    posted,
    postMessage: (data: unknown) => { posted.push(data) },
    addEventListener: (type: string, cb: Listener) => { (listeners[type] ??= []).push(cb) },
    fire: (type: string) => { for (const cb of listeners[type] ?? []) cb() },
  }
}

const fakeContainer = (
  { waiting, controller = true, registeredYet = true }:
  { waiting: unknown, controller?: boolean, registeredYet?: boolean },
) => {
  const listeners: Record<string, Listener[]> = {}
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
    controller: controller ? {} : null,
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
    /** what the browser fires once a worker calls skipWaiting and claims this page */
    controllerChange: () => {
      registration.waiting = null
      for (const cb of listeners.controllerchange ?? []) cb()
    },
    /** an install that lands while the page is already open */
    installs: (worker: unknown) => {
      registration.installing = worker
      for (const cb of regListeners.updatefound ?? []) cb()
      registration.installing = null
      registration.waiting = worker
      ;(worker as ReturnType<typeof fakeWorker>).fire('statechange')
    },
    install: () => {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
    },
    /** index.tsx registers on `load`, so this is the moment that page finally has a registration */
    registers: () => arrive(registration),
  }
}

afterEach(() => {
  reloaded.count = 0
  // the own property shadows the real container; deleting it hands the real one back
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
})

/** `Infinity` is inside the window and `0` is past it, whatever the runner's page age happens to be. */
const mount = async (adoptWindowMs: number) => {
  const { useRippleUpdate } = await import('../../src/utils/use-ripple-update')
  const Probe = () => {
    const { ready, update } = useRippleUpdate(adoptWindowMs)
    return <button type="button" onClick={update}>{ready ? 'ready' : 'idle'}</button>
  }
  return render(<Probe />)
}

describe('a refresh that lands on a new build', () => {
  it('takes the waiting worker instead of offering a button', async () => {
    const worker = fakeWorker()
    const sw = fakeContainer({ waiting: worker })
    sw.install()

    const screen = await mount(Infinity)
    await expect.poll(() => worker.posted).toEqual([{ type: 'take-over' }])
    expect(screen.container.textContent, 'the page asked as well as taking').toBe('idle')
  })

  /**
   * The adopting page is ALREADY the build it just took, so a reload would spend a whole page load
   * arriving where it is. Every other tab still reloads; that half is `update` below.
   */
  it('does not reload itself once the worker takes over', async () => {
    const worker = fakeWorker()
    const sw = fakeContainer({ waiting: worker })
    sw.install()

    const screen = await mount(Infinity)
    await expect.poll(() => worker.posted.length).toBe(1)
    sw.controllerChange()
    await expect.poll(() => screen.container.textContent).toBe('idle')
    expect(reloaded.count, 'the page reloaded onto the build it was already running').toBe(0)
  })
})

describe('an update that arrives while the page sits open', () => {
  /**
   * This page is running the OLD build, and the new worker's activate deletes the cache generation
   * its lazy chunks live in, whose paths the deploy has rotated away. So it asks.
   */
  it('offers the button and takes nothing on its own', async () => {
    const worker = fakeWorker()
    const sw = fakeContainer({ waiting: null })
    sw.install()

    const screen = await mount(0)
    await expect.poll(() => screen.container.textContent).toBe('idle')

    sw.installs(worker)
    await expect.poll(() => screen.container.textContent).toBe('ready')
    expect(worker.posted, 'the page took the update without being asked').toEqual([])
  })

  it('takes it when the button is pressed, and lets controllerchange do the reloading', async () => {
    const worker = fakeWorker()
    const sw = fakeContainer({ waiting: null })
    sw.install()

    const screen = await mount(0)
    sw.installs(worker)
    await expect.poll(() => screen.container.textContent).toBe('ready')

    await screen.getByRole('button').click()
    expect(worker.posted).toEqual([{ type: 'take-over' }])
    // the press itself reloads nothing: the worker taking over is what does, here and in every tab
    expect(reloaded.count).toBe(0)
    sw.controllerChange()
    await expect.poll(() => reloaded.count).toBe(1)
  })
})

/**
 * A page with no controller has never had a worker, so a first-ever claim is not an update and a
 * reload there would be a flicker on somebody's first visit.
 */
it('does not reload a page that never had a controller', async () => {
  const sw = fakeContainer({ waiting: null, controller: false })
  sw.install()

  await mount(0)
  sw.controllerChange()
  await expect.poll(() => reloaded.count).toBe(0)
})

/**
 * A FIRST-EVER VISIT has no registration when the page asks for one: index.tsx registers the worker
 * on `load`, after this effect has already run. That page used to give up there and watch nothing
 * for as long as it stayed open, so an update installing under it fired `updatefound` into a page
 * with no listener and the button never appeared.
 */
it('watches a registration that only exists after the first look', async () => {
  const worker = fakeWorker()
  const sw = fakeContainer({ waiting: null, registeredYet: false })
  sw.install()

  const screen = await mount(0)
  await expect.poll(() => screen.container.textContent).toBe('idle')

  sw.registers()
  sw.installs(worker)
  await expect.poll(() => screen.container.textContent).toBe('ready')
})
