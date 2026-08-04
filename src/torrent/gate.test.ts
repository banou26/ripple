// A command parked behind the gate must survive the gate being re-armed. Losing it is silent: no error,
// no retry, and the engine simply never hears what the page asked for.

import { describe, expect, it, vi } from 'vitest'

import { createGate } from './gate'

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('createGate', () => {
  it('runs a waiter once the gate opens', async () => {
    const gate = createGate()
    const ran = vi.fn()
    gate.wait(ran)
    await settle()
    expect(ran).not.toHaveBeenCalled()

    gate.open()
    await settle()
    expect(ran).toHaveBeenCalledTimes(1)
  })

  // THE REGRESSION. `arm` runs when the engine is replaced, which is what happens the moment a document
  // wins the engine election, ~13ms after boot. /embed issues add-magnet inside that window. Re-arming
  // by simply replacing the promise stranded that command forever: the old promise had no resolver left.
  it('wakes a waiter parked on the gate it retires', async () => {
    const gate = createGate()
    const ran = vi.fn()
    gate.wait(ran)
    await settle()

    gate.arm()
    await settle()
    expect(ran).toHaveBeenCalledTimes(1)
  })

  // the real caller re-parks when it is still too early, so the wake has to land it on the NEW gate,
  // not on the one being retired, or the second park is stranded exactly as the first was
  it('lets a woken waiter re-park on the current gate and still run later', async () => {
    const gate = createGate()
    let ready = false
    const delivered = vi.fn()
    const attempt = () => {
      if (!ready) { gate.wait(attempt); return }
      delivered()
    }

    gate.wait(attempt)
    await settle()
    gate.arm()          // the engine was replaced while the command was still waiting
    await settle()
    expect(delivered).not.toHaveBeenCalled()

    ready = true
    gate.open()
    await settle()
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('survives several re-arms before the engine is ready', async () => {
    const gate = createGate()
    let ready = false
    const delivered = vi.fn()
    const attempt = () => {
      if (!ready) { gate.wait(attempt); return }
      delivered()
    }

    gate.wait(attempt)
    for (let i = 0; i < 5; i++) { gate.arm(); await settle() }
    expect(delivered).not.toHaveBeenCalled()

    ready = true
    gate.open()
    await settle()
    expect(delivered).toHaveBeenCalledTimes(1)
  })
})
