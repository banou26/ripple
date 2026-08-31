import type { PersistState } from '../torrent/storage-permission'

import { render } from 'vitest-browser-react'
import { expect, test, vi } from 'vitest'

import { PersistControl } from './persist-control'

/**
 * The footer control, which unlike `PersistOffer` must render in EVERY state: a control that hides
 * itself once it is answered sends somebody looking for a browser setting instead of showing them
 * the answer. So each case below asserts the label AND whether it can be pressed.
 */
const state = (over: Partial<PersistState> = {}): PersistState =>
  ({ persisted: false, permission: 'prompt', attempted: false, granted: null, ...over })

const button = (c: HTMLElement) => c.querySelector('button')!

const mount = (persist: PersistState, onAsk = () => {}) =>
  render(<PersistControl persist={persist} onAsk={onAsk}/>)

test('offers the ask where a prompt can still be raised', async () => {
  const { container } = await mount(state())
  expect(button(container).textContent).toBe('Ask for more room')
  expect(button(container).disabled).toBe(false)
  // the state is not the good one yet, so the footer's "this is live" class must be absent
  expect(button(container).className).not.toContain('on')
})

test('an already persistent origin reports it and cannot be pressed', async () => {
  const { container } = await mount(state({ persisted: true }))
  expect(button(container).textContent).toBe('Persistent')
  expect(button(container).disabled).toBe(true)
  expect(button(container).className).toContain('on')
})

test('a browser setting that says no reports Blocked and cannot be pressed', async () => {
  const { container } = await mount(state({ permission: 'denied' }))
  expect(button(container).textContent).toBe('Blocked')
  expect(button(container).disabled).toBe(true)
})

test('an ask the browser refused by itself reports it without blaming the person', async () => {
  const { container } = await mount(state({ attempted: true, granted: false }))
  expect(button(container).textContent).toBe('Not granted')
  expect(button(container).disabled).toBe(true)
  // the hint is the only place the reason lives once the button is dead, so it has to be there.
  // hint() writes data-tooltip-content, not title: react-tooltip matches anchors by id
  expect(button(container).getAttribute('data-tooltip-content') ?? '').toMatch(/browser answered no/)
})

test('an engine that will not answer the permission query still gets the button', async () => {
  const { container } = await mount(state({ permission: 'unknown' }))
  expect(button(container).disabled).toBe(false)
})

test('asks once however fast the button is pressed twice', async () => {
  const onAsk = vi.fn()
  const { container } = await mount(state(), onAsk)
  // both clicks land in one tick, before React can re-render the button as disabled: the ref latch
  // is what stops the second, and `disabled` alone would not (measured in persist-offer's tests)
  button(container).click()
  button(container).click()
  expect(onAsk).toHaveBeenCalledTimes(1)
  await expect.poll(() => button(container).disabled).toBe(true)
})
