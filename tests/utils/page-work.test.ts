import { describe, expect, it } from 'vitest'

import { pageWork, pageWorkRunning } from '../../src/utils/page-work'

/** Ripple's update gate holds while this answers true, for work in any Ripple page of the origin. */
describe('page work', () => {
  const held = () => {
    let release = (_fail?: boolean) => {}
    const done = new Promise<void>((resolve, reject) => {
      release = (fail) => (fail ? reject(new Error('failed')) : resolve())
    })
    return { done, release }
  }
  const lockHeld = async () => (await navigator.locks.query()).held?.some((lock) => lock.name === 'ripple:page-work') ?? false
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('runs from its start until it settles, failed or not', async () => {
    const work = held()
    const running = pageWork(() => work.done)
    expect(await pageWorkRunning()).toBe(true)
    work.release(true)
    await expect(running).rejects.toThrow('failed')
    expect(await pageWorkRunning()).toBe(false)
  })

  it('starts the work at once, so a picker it opens keeps the click', () => {
    let started = false
    void pageWork(async () => { started = true })
    expect(started).toBe(true)
  })

  it('shows other pages the work while it runs', async () => {
    const work = held()
    const running = pageWork(() => work.done)
    await expect.poll(lockHeld).toBe(true)
    work.release()
    await running
    await expect.poll(lockHeld).toBe(false)
  })

  it('lets go of the lock when the work ends before the lock is granted', async () => {
    // an exclusive holder keeps the shared request waiting until after the work has ended
    const blocker = held()
    void navigator.locks.request('ripple:page-work', () => blocker.done)
    await pageWork(async () => {})
    blocker.release()
    await sleep(50)
    expect(await lockHeld()).toBe(false)
  })

  it('sees work another page holds', async () => {
    const other = held()
    void navigator.locks.request('ripple:page-work', { mode: 'shared' }, () => other.done)
    await expect.poll(pageWorkRunning).toBe(true)
    other.release()
    await expect.poll(pageWorkRunning).toBe(false)
  })
})
