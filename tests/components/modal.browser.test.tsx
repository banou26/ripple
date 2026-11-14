import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { useRef, useState } from 'react'

import { Modal, MODAL_Z_INDEX } from '../../src/components/modal'

/**
 * The modal shell, which exists because `<dialog>.showModal()` could not be arranged around.
 *
 * showModal moves an element into the TOP LAYER, a painting surface above the whole z-index system,
 * so while one was open @fkn/lib's broker frame was covered whatever number it carried and an FKN
 * consent prompt raised during a confirmation could not be answered. Measured, along with every
 * escape route that does not work: a popover promoted first still lost, re-promoting it still lost,
 * and the frame was inert underneath even where it was visible.
 *
 * So the shell stays in ordinary stacking one step below the broker, and has to do by hand
 * everything showModal was doing for free. Each of those is a test here, because dropping the API
 * is not a reason to drop the behaviour.
 */

const Harness = ({ onClose = () => {}, focusCancel = false }: { onClose?: () => void, focusCancel?: boolean }) => {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button type="button">behind the modal</button>
      <Modal labelledBy="t" onClose={onClose} initialFocus={focusCancel ? cancel : undefined}>
        <div>
          <h2 id="t">A question</h2>
          <button type="button">first</button>
          <button type="button" ref={cancel}>cancel</button>
        </div>
      </Modal>
    </div>
  )
}

const overlay = () => document.querySelector('[role="dialog"]') as HTMLElement

describe('the modal shell', () => {
  it('announces itself as a modal dialog and names its title', async () => {
    render(<Harness/>)
    await expect.poll(overlay).not.toBeNull()
    expect(overlay().getAttribute('aria-modal')).toBe('true')
    expect(overlay().getAttribute('aria-labelledby')).toBe('t')
  })

  /** the number IS the design: one below the broker frame, so only FKN can cover a modal */
  it('sits one step below the broker frame, and above everything ripple draws', async () => {
    render(<Harness/>)
    await expect.poll(overlay).not.toBeNull()
    expect(MODAL_Z_INDEX).toBe(2147483646)
    expect(Number(getComputedStyle(overlay()).zIndex)).toBe(MODAL_Z_INDEX)
    // the context menu is the highest thing ripple draws
    expect(MODAL_Z_INDEX).toBeGreaterThan(2000)
  })

  it('escapes to the body rather than rendering in place', async () => {
    render(<Harness/>)
    await expect.poll(overlay).not.toBeNull()
    // an ancestor with a transform or a filter becomes the containing block for position:fixed, so
    // rendering in place would quietly stop the modal covering the viewport at all
    expect(overlay().parentElement).toBe(document.body)
  })

  it('closes on Escape, which is what showModal used to raise as cancel', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose}/>)
    await expect.poll(overlay).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a click outside the content, and not on one inside it', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose}/>)
    await expect.poll(overlay).not.toBeNull()
    overlay().querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClose).toHaveBeenCalled()
  })

  it('focuses what it was pointed at, never merely the first control', async () => {
    render(<Harness focusCancel/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('cancel')
  })

  it('falls back to the first control when pointed at nothing', async () => {
    render(<Harness/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('first')
  })

  /**
   * Without this Tab walks out of the modal into a page that looks interactive and is inert, which
   * reads as the keyboard having stopped working rather than as a trap doing its job.
   */
  it('keeps Tab inside, wrapping at both ends', async () => {
    render(<Harness/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('first')
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement?.textContent).toBe('cancel')
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement?.textContent).toBe('first')
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement?.textContent).toBe('cancel')
  })

  // a click on its text used to leave the focus on the page, where Escape closed nothing and Tab walked off
  it('keeps Escape and Tab its own after a click on its text', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose}/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('first')
    await userEvent.click(overlay().querySelector('h2')!)
    expect(overlay().contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement?.textContent).toBe('cancel')
    await userEvent.click(overlay().querySelector('h2')!)
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement?.textContent).toBe('first')
    await userEvent.click(overlay().querySelector('h2')!)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('what is left reachable behind it', () => {
  it('makes the rest of the page inert, as showModal did', async () => {
    const behind = document.createElement('div')
    behind.innerHTML = '<button>behind</button>'
    document.body.appendChild(behind)
    try {
      render(<Harness/>)
      await expect.poll(overlay).not.toBeNull()
      expect(behind.inert).toBe(true)
    } finally { behind.remove() }
  })

  /**
   * The whole reason the shell exists. @fkn/lib draws its prompts in that frame, and inerting it
   * would put back exactly what the top layer was doing: an FKN question visible above the modal
   * and impossible to answer. It is identified by the title @fkn/lib gives it, which is the only
   * handle available from out here.
   */
  it('leaves the FKN broker frame alone', async () => {
    const frame = document.createElement('iframe')
    frame.title = 'FKN'
    document.body.appendChild(frame)
    try {
      render(<Harness/>)
      await expect.poll(overlay).not.toBeNull()
      expect(frame.inert).toBe(false)
    } finally { frame.remove() }
  })

  it('gives every element back when it closes, and only the ones it took', async () => {
    const already = document.createElement('div')
    already.inert = true
    document.body.appendChild(already)
    const fresh = document.createElement('div')
    document.body.appendChild(fresh)
    try {
      // closed by its own state rather than by unmounting the tree, which is how a real one goes
      const Toggling = () => {
        const [open, setOpen] = useState(true)
        return open
          ? <Modal labelledBy="x" onClose={() => setOpen(false)}><h2 id="x">q</h2><button>shut</button></Modal>
          : <p>closed</p>
      }
      render(<Toggling/>)
      await expect.poll(overlay).not.toBeNull()
      expect(fresh.inert).toBe(true)
      await userEvent.keyboard('{Escape}')
      await expect.poll(overlay).toBeNull()
      expect(fresh.inert).toBe(false)
      // it was inert before the modal opened, so it is not the modal's to hand back
      expect(already.inert).toBe(true)
    } finally { already.remove(); fresh.remove() }
  })
})

/*
 * Inside a player: the fullscreen element shows nothing outside itself, so a modal portalled to the body is
 * invisible there. Drawn in place it is the player's child, and the player reads every key that reaches the
 * window and every click that reaches its picture.
 */
describe('drawn inside a player', () => {
  const heard = { keys: [] as string[], clicks: 0, doubleClicks: 0 }
  const hearKey = (event: KeyboardEvent) => { heard.keys.push(event.key) }

  // the card is taller than the player, and the control that takes the focus is at its foot
  const Player = ({ onClose = () => {}, inline = true }: { onClose?: () => void, inline?: boolean }) => {
    const last = useRef<HTMLButtonElement>(null)
    return (
      <div id="player" style={{ position: 'relative', width: 480, height: 200 }} onClick={() => { heard.clicks++ }} onDoubleClick={() => { heard.doubleClicks++ }}>
        <div style={{ position: 'absolute', inset: 'auto 0 0 0', height: 40, zIndex: 2 }}><button type="button">a control of the player</button></div>
        <Modal labelledBy="s" onClose={onClose} inline={inline} initialFocus={last}>
          <div>
            <p id="s">A sentence</p>
            <button type="button">first</button>
            <div style={{ height: 220 }}/>
            <button type="button" ref={last}>last</button>
          </div>
        </Modal>
      </div>
    )
  }

  const listening = async (run: () => Promise<void>) => {
    heard.keys.length = 0
    heard.clicks = heard.doubleClicks = 0
    window.addEventListener('keydown', hearKey)
    try { await run() } finally { window.removeEventListener('keydown', hearKey) }
  }

  it('is the player\'s own child, over all of it, its controls included', async () => {
    render(<Player/>)
    await expect.poll(overlay).not.toBeNull()
    const player = document.getElementById('player')!
    expect(overlay().parentElement).toBe(player)
    expect(overlay().getBoundingClientRect()).toEqual(player.getBoundingClientRect())
    // what is hit where the player draws a control is the modal
    const control = player.querySelector('button')!.getBoundingClientRect()
    expect(overlay().contains(document.elementFromPoint(control.left + 5, control.top + 5))).toBe(true)
  })

  it('makes nothing behind it inert: the page around a player stays the page', async () => {
    const behind = document.body.appendChild(document.createElement('div'))
    try {
      render(<Player/>)
      await expect.poll(overlay).not.toBeNull()
      expect(behind.inert).toBe(false)
    } finally { behind.remove() }
  })

  it('opens at its first line when it is taller than the player, and scrolls', async () => {
    render(<Player/>)
    await expect.poll(overlay).not.toBeNull()
    await expect.poll(() => document.activeElement?.textContent).toBe('last')
    expect(overlay().scrollHeight).toBeGreaterThan(overlay().clientHeight)
    // not scrolled to the control that has the focus, which would hide the sentence
    expect(overlay().scrollTop).toBe(0)
    expect(getComputedStyle(overlay()).overflowY).toBe('auto')
  })

  it('lets no key and no click reach the player', async () => {
    const onClose = vi.fn()
    render(<Player onClose={onClose}/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('last')
    await listening(async () => {
      await userEvent.keyboard(' ')
      await userEvent.keyboard('f')
      await userEvent.keyboard('{Tab}')
      await userEvent.click(overlay().querySelector('p')!)
      await userEvent.dblClick(overlay().querySelector('p')!)
      await userEvent.keyboard('{Escape}')
    })
    expect(heard).toEqual({ keys: [], clicks: 0, doubleClicks: 0 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // THE CONTROL: the same keys and clicks, in a modal over the page, are heard
  it('is heard through a modal drawn over the page (control)', async () => {
    render(<Player inline={false}/>)
    await expect.poll(() => document.activeElement?.textContent).toBe('last')
    await listening(async () => {
      await userEvent.keyboard(' ')
      await userEvent.click(overlay().querySelector('p')!)
    })
    expect(heard.keys).toEqual([' '])
    // a portal's events bubble through the tree it was rendered in
    expect(heard.clicks).toBeGreaterThan(0)
  })
})
