import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

const subscribed = vi.hoisted((): Record<string, Set<(value?: unknown) => void>> => ({}))
const sessionLimitCalls = vi.hoisted(() => [] as { down?: number, up?: number }[])
const syncMocks = vi.hoisted(() => ({
  recordRateLimitsPatch: vi.fn(async () => 'synced' as const),
}))

const client = new Proxy({}, {
  get: (_, key) => {
    if (key === 'setSessionLimits') {
      return (patch: { down?: number, up?: number }) => {
        sessionLimitCalls.push(patch)
        return Promise.resolve()
      }
    }
    if (typeof key === 'string' && key.startsWith('on')) {
      return (cb: (value?: unknown) => void) => {
        ;(subscribed[key] ??= new Set()).add(cb)
        return () => { subscribed[key]?.delete(cb) }
      }
    }
    return key === 'owns' ? () => false : () => Promise.resolve()
  },
})

vi.mock('../../src/torrent/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/client')>()),
  getTorrentClient: () => client,
  runningTorrentClient: () => null,
}))
vi.mock('../../src/torrent/settings-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/settings-sync')>()),
  recordRateLimitsPatch: syncMocks.recordRateLimitsPatch,
}))

const { IntlRoot } = await import('../../src/i18n')
const { default: Home } = await import('../../src/router/home')

it('keeps the footer ceiling on Unlimited down until the worker broadcasts the persisted value', async () => {
  await render(<IntlRoot><MemoryRouter><Home/></MemoryRouter></IntlRoot>)

  const downButton = () => document.querySelector('footer .controls button') as HTMLButtonElement | null
  await expect.poll(() => downButton()?.textContent).toBe('Unlimited down')

  await userEvent.click(downButton()!)
  const checkbox = () => document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement | null
  const field = () => document.querySelector('[role="dialog"] input[type="number"]') as HTMLInputElement | null
  const applyButton = () => document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement | null
  await expect.poll(checkbox).not.toBeNull()

  await userEvent.click(checkbox()!)
  await userEvent.fill(field()!, '1500')
  await userEvent.click(applyButton()!)
  await expect.poll(applyButton).toBeNull()

  expect(sessionLimitCalls).toEqual([{ down: 1_500_000 }])
  expect(syncMocks.recordRateLimitsPatch).toHaveBeenCalledWith({ down: 1_500_000 }, { down: 0, up: 0 })
  expect(downButton()?.textContent).toBe('Unlimited down')

  for (const cb of subscribed.onRateLimits ?? []) cb({ down: 1_500_000, up: 0 })
  await expect.poll(() => downButton()?.textContent).toBe('1.5 MB/s down')
})
