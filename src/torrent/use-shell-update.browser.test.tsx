import type { TorrentState } from './types'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * What ripple does when somebody takes an FKN shell update.
 *
 * The lib reloads the page by default and reaches EVERY open page, not only the one where the
 * button was pressed. Registering a handler at all is what suppresses that, so the two failures
 * worth pinning are:
 *
 *  - the handler never registers, and the lib reloads a page mid-download without asking. Silent:
 *    nothing throws, and it only shows up when somebody's transfer stops.
 *  - the handler registers and then reloads anyway, which is the same outcome by a longer route.
 *
 * The real thing ends in `location.reload()`, which a test cannot let happen, so the hook's reload
 * is the one thing stubbed here. Everything else is the actual code.
 */

/** the broker handler ripple hands to @fkn/lib, captured so the test can fire it */
let taken: (() => void) | null = null
let unsubscribed = 0

vi.mock('@fkn/lib', () => ({
  shell: {
    onUpdateTaken: (handler: () => void) => {
      taken = handler
      return () => { unsubscribed += 1; taken = null }
    },
  },
}))

// the live engine feed the hook watches, driven by the test
let emit: ((snapshots: unknown[]) => void) | null = null
vi.mock('./client', () => ({
  getTorrentClient: () => ({
    onState: (cb: (snapshots: unknown[]) => void) => { emit = cb; return () => { emit = null } },
  }),
}))

// the states arrive as engine snapshots; this test drives the derived state directly
vi.mock('./use-torrents', () => ({ snapshotState: (s: { state: TorrentState }) => s.state }))

// `location` itself cannot be stubbed in a real browser, which is why the reload has its own module
const reloads: string[] = []
vi.mock('../utils/reload', () => ({ reloadPage: () => { reloads.push('reload') } }))

const { useShellUpdate } = await import('./use-shell-update')

const Harness = () => {
  const { pending, reload } = useShellUpdate()
  return (
    <div>
      <span data-testid="pending">{pending ? 'pending' : 'idle'}</span>
      <button type="button" onClick={reload}>Reload now</button>
    </div>
  )
}

const pendingText = () => document.querySelector('[data-testid="pending"]')?.textContent

const withTorrents = (...states: TorrentState[]) => { emit?.(states.map((state) => ({ state }))) }

beforeEach(() => {
  taken = null
  emit = null
  unsubscribed = 0
  reloads.length = 0
})

describe('an FKN update taken while ripple is open', () => {
  it('registers a handler, which is what stops the lib reloading on its own', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
  })

  it('takes the update straight away when nothing is running', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    withTorrents('done', 'paused')
    taken!()
    await expect.poll(() => reloads.length).toBe(1)
    expect(pendingText()).toBe('idle')
  })

  it('reloads on an empty library, where there is nothing to protect', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    withTorrents()
    taken!()
    await expect.poll(() => reloads.length).toBe(1)
  })

  /** the one that matters: a download must not be cut off by a button pressed in another tab */
  it('holds off and asks instead when a torrent is downloading', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    withTorrents('done', 'downloading')
    taken!()
    await expect.poll(pendingText).toBe('pending')
    expect(reloads).toHaveLength(0)
  })

  it('holds off for seeding too, which a reload also cuts off', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    withTorrents('seeding')
    taken!()
    await expect.poll(pendingText).toBe('pending')
    expect(reloads).toHaveLength(0)
  })

  it('reads the library as it is when update is pressed, not as it was at mount', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    // busy at mount, finished by the time somebody presses update
    withTorrents('downloading')
    withTorrents('done')
    taken!()
    await expect.poll(() => reloads.length).toBe(1)
    expect(pendingText()).toBe('idle')
  })

  it('still lets the person take it from the banner while busy', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    withTorrents('downloading')
    taken!()
    await expect.poll(pendingText).toBe('pending')
    // clicked through the DOM: this file mounts several harnesses, so a page-scoped query would
    // resolve to more than one button
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reload now')
    button!.click()
    await expect.poll(() => reloads.length).toBe(1)
  })
})
