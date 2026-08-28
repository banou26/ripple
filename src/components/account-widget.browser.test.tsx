import type { AccountInfo } from '../torrent/use-account'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

/**
 * The account tag, and the menu it opens.
 *
 * Nothing in this repo asserted anything about the account area before this file, which is part of
 * why the tag could sit there for months spending header width on a Disconnect button while
 * offering no way to reach the account itself.
 *
 * Two things here are worth more than the rest. The first is that pressing the tag a SECOND time
 * closes the menu: the outside-press listener runs in the capture phase, so without a carve-out for
 * the trigger the press closes and the click reopens, and the control that opens the menu can never
 * close it. That failure looks like the menu ignoring you and is invisible in a screenshot.
 *
 * The second is that nothing here is driven off `logout()` resolving. It cannot report failure (the
 * library swallows its only error) and it awaits a broker handshake with no timeout, so it can hang
 * forever. `info` going null is the only honest evidence a disconnect happened, and the toast is
 * gated so a logout in ANOTHER tab cannot make this one claim credit.
 */

const account = {
  info: null as AccountInfo,
  ready: true,
  logout: vi.fn(async () => {}),
}
vi.mock('../torrent/use-account', () => ({ useAccount: () => account }))
// so a test never creates a cross-origin iframe to fkn.app
vi.mock('@fkn/lib/react', () => ({ ConnectButton: () => <div data-testid="connect"/> }))

const { AccountWidget, LOGOUT_TIMEOUT } = await import('./account-widget')

const signedIn = (over: Partial<{ name: string, premium: boolean }> = {}) =>
  ({ name: 'banou', premium: false, ...over }) as unknown as AccountInfo

const onToast = vi.fn()

/**
 * Rendered inside a right-aligned strip that is INSET from the viewport, the way the header holds
 * it.
 *
 * Both halves are load bearing, and each defeats the placement assertion in its own direction. A
 * trigger at x=0 is placed by the alignment but the assertion would pass with no alignment code at
 * all, since left is where an unplaced menu already sits. A trigger flush against the right edge is
 * placed by the viewport CLAMP instead of by the alignment, which lands it 8px short and fails an
 * assertion about code that is working. The header's own padding is what puts the real trigger
 * between the two, so the fixture reproduces it.
 */
const mount = () => render(
  <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%', boxSizing: 'border-box', paddingRight: 24 }}>
    <AccountWidget onToast={onToast}/>
  </div>,
)

const trigger = () => document.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement
const connect = () => document.querySelector('[data-testid="connect"]')
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null

/** React 19 commits off the render call, so nothing is on screen on the turn `render` returns. */
const mounted = async () => {
  const screen = mount()
  await expect.poll(trigger).not.toBeNull()
  return screen
}

/** For the two states that render no tag: let the commit happen, THEN assert the absence. */
const settled = async () => {
  const screen = mount()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return screen
}
const items = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
const labelOf = (el: Element | null | undefined) => el?.querySelector('.text')?.textContent?.trim()
const byLabel = (label: string) => items().find((el) => labelOf(el) === label)!
const active = () => {
  const el = document.activeElement
  return el?.matches('[role^="menuitem"]') ? labelOf(el) : undefined
}

/** The menu's effects place it, focus it and attach its listeners, none of which has happened yet. */
const openMenu = async () => {
  await userEvent.click(trigger())
  await expect.poll(() => document.activeElement?.closest('[role="menu"]')).not.toBeNull()
}

beforeEach(() => {
  account.info = signedIn()
  account.ready = true
  account.logout = vi.fn(async () => {})
  onToast.mockClear()
})

afterEach(() => { vi.useRealTimers() })

describe('the account tag before it has an account', () => {
  it('renders nothing at all while the broker has not answered', async () => {
    account.ready = false
    await settled()
    expect(trigger()).toBeNull()
    expect(connect()).toBeNull()
  })

  it('offers the connect button when nobody is signed in', async () => {
    account.info = null
    await settled()
    await expect.poll(connect).not.toBeNull()
    expect(trigger()).toBeNull()
  })
})

describe('the account tag', () => {
  it('says who you are and that it opens a menu', async () => {
    await mounted()
    expect(trigger().textContent).toContain('banou')
    expect(trigger().textContent).toContain('Free')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  /**
   * An aria-label REPLACES the content rather than adding to it, so leaving the tier out of it
   * hides one of the two facts the tag exists to state from anyone who cannot see it.
   */
  it('carries both facts in its accessible name, not just the name', async () => {
    account.info = signedIn({ premium: true })
    await mounted()
    expect(trigger().getAttribute('aria-label')).toContain('banou')
    expect(trigger().getAttribute('aria-label')).toContain('Premium')
  })

  it('opens a menu when pressed, and says so', async () => {
    await mounted()
    await openMenu()
    expect(menu()).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  /**
   * The header carries backdrop-filter, which is both a stacking context and a containing block for
   * fixed descendants, so a menu left inside it would be positioned against the header box while
   * its arithmetic reads the viewport, and would paint under the toast.
   */
  it('portals the menu out of the header rather than nesting it', async () => {
    await mounted()
    await openMenu()
    expect(menu()!.closest('header')).toBeNull()
    expect(menu()!.parentElement).toBe(document.body)
  })

  it('offers exactly the two things there are to do', async () => {
    await mounted()
    await openMenu()
    expect(items()).toHaveLength(2)
    expect(items().map(labelOf)).toEqual(['Manage account', 'Disconnect'])
  })

  /**
   * A real anchor, not a button calling window.open, so middle-click, ctrl-click, "open in new tab"
   * and the browser's own preview of where it goes all keep working.
   */
  it('sends you to the account page with a link, not a script', async () => {
    await mounted()
    await openMenu()
    const manage = byLabel('Manage account')
    expect(manage.tagName).toBe('A')
    expect(manage.getAttribute('href')).toBe('https://fkn.app/account')
    expect(manage.getAttribute('target')).toBe('_blank')
    expect(manage.getAttribute('rel')).toBe('noreferrer')
  })

  it('hangs the menu under the tag, end-aligned with it', async () => {
    await mounted()
    await openMenu()
    // placement runs in a layout effect, so poll rather than read the first frame
    await expect.poll(() => Math.abs(menu()!.getBoundingClientRect().right - trigger().getBoundingClientRect().right))
      .toBeLessThanOrEqual(1)
    expect(menu()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(trigger().getBoundingClientRect().bottom)
  })

  /**
   * THE REGRESSION. The outside-press listener is capture phase, so without a carve-out for the
   * trigger the press closes the menu and the click that follows immediately reopens it.
   */
  it('closes when the tag is pressed a second time', async () => {
    await mounted()
    await openMenu()
    await userEvent.click(trigger())
    await expect.poll(menu).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('walks with the arrow keys, entering from the top and from the bottom', async () => {
    await mounted()
    await openMenu()
    // nothing is selected on open: a ring on the first row reads as a choice the user did not make
    expect(active()).toBeUndefined()
    await userEvent.keyboard('{ArrowDown}')
    await expect.poll(active).toBe('Manage account')
    await userEvent.keyboard('{ArrowDown}')
    await expect.poll(active).toBe('Disconnect')
  })

  it('enters at the last row when arrowing up from the container', async () => {
    await mounted()
    await openMenu()
    await userEvent.keyboard('{ArrowUp}')
    await expect.poll(active).toBe('Disconnect')
  })

  it('closes on Escape and hands focus back to the tag', async () => {
    await mounted()
    await openMenu()
    await userEvent.keyboard('{Escape}')
    await expect.poll(menu).toBeNull()
    await expect.poll(() => document.activeElement).toBe(trigger())
  })

  it('closes when something outside it is pressed', async () => {
    await mounted()
    await openMenu()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await expect.poll(menu).toBeNull()
  })

  /**
   * The inverse of the context menu's rule, and deliberate. That one is pinned to a coordinate the
   * page moves out from under; this one is pinned to a control in a header that does not scroll.
   */
  it('survives a scroll, which would close the pointer menu', async () => {
    await mounted()
    await openMenu()
    window.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(menu()).not.toBeNull()
  })
})

describe('disconnecting', () => {
  /** A deferred logout, so the in-flight state can be looked at rather than raced past. */
  const deferred = () => {
    let settle = () => {}
    const promise = new Promise<void>((resolve) => { settle = resolve })
    account.logout = vi.fn(() => promise)
    return { settle }
  }

  it('says it is working, and keeps the menu open while it is', async () => {
    deferred()
    await mounted()
    await openMenu()
    await userEvent.click(byLabel('Disconnect'))
    await expect.poll(() => labelOf(byLabel('Disconnecting...'))).toBe('Disconnecting...')
    expect((byLabel('Disconnecting...') as HTMLButtonElement).disabled).toBe(true)
    // still open, because this row is the only place anything is being reported
    expect(menu()).not.toBeNull()
    expect(account.logout).toHaveBeenCalledTimes(1)
  })

  it('announces the result once the account is actually gone', async () => {
    const { settle } = deferred()
    const screen = await mounted()
    await openMenu()
    await userEvent.click(byLabel('Disconnect'))
    account.info = null
    settle()
    await expect.poll(connect).not.toBeNull()
    expect(menu()).toBeNull()
    expect(onToast).toHaveBeenCalledWith('Disconnected')
  })

  /**
   * A logout somewhere else, or the thirty second poll finding the account gone. The menu has to
   * close, but THIS tab did not disconnect anything and must not say it did.
   */
  it('closes the menu without claiming credit when the account goes on its own', async () => {
    const screen = await mounted()
    await openMenu()
    account.info = null
    // the widget re-renders from the hook, which the mock drives off the next render
    screen.rerender(
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
        <AccountWidget onToast={onToast}/>
      </div>,
    )
    await expect.poll(menu).toBeNull()
    expect(onToast).not.toHaveBeenCalled()
  })

  /**
   * `logout()` awaits the broker handshake through a promise with no timeout, so a frame that never
   * establishes leaves the row reading "Disconnecting..." until the page is reloaded. The cap
   * clears the label, and deliberately does NOT announce a disconnect: a timeout is not evidence.
   */
  it('gives up on a logout that never answers, and stays quiet about it', async () => {
    account.logout = vi.fn(() => new Promise<void>(() => {}))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mounted()
    await openMenu()
    await userEvent.click(byLabel('Disconnect'))
    await expect.poll(() => !!byLabel('Disconnecting...')).toBe(true)
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT + 100)
    await expect.poll(menu).toBeNull()
    expect(onToast).not.toHaveBeenCalled()
    // and the tag is still there, because nothing actually disconnected
    expect(trigger()).not.toBeNull()
  })

  /**
   * The step the test above stops one short of, and the reason the arming is a TIMESTAMP.
   *
   * A boolean flag has no way to expire. After a logout that hung past the cap the session is still
   * alive, so no null ever arrives to clear the flag, and it sits armed for the life of the page
   * waiting to hand its credit to something else. The something else is ordinary: the hook's own
   * four second `info()` race resolves null for a broker that is merely slow. The user then reads
   * "Disconnected" about an account they are still signed into.
   */
  it('does not blame a later broker hiccup on a disconnect that already gave up', async () => {
    account.logout = vi.fn(() => new Promise<void>(() => {}))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const screen = await mounted()
    await openMenu()
    await userEvent.click(byLabel('Disconnect'))
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT + 100)
    await expect.poll(menu).toBeNull()

    // long enough later that this null cannot be the disconnect, then a null from somewhere else
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT * 2)
    account.info = null
    screen.rerender(
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%', boxSizing: 'border-box', paddingRight: 24 }}>
        <AccountWidget onToast={onToast}/>
      </div>,
    )
    await expect.poll(connect).not.toBeNull()
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('the menu keyboard, on rows that are not all buttons', () => {
  /**
   * A button activates on Space for free, so this was invisible while every row was one. The
   * settings row is an anchor, which takes Enter only, and two rows that look identical answering
   * differently to the same key is the kind of thing nobody reports, they just decide it is broken.
   */
  it('activates a link row with Space, the way it activates a button row', async () => {
    await mounted()
    await openMenu()
    await userEvent.keyboard('{ArrowDown}')
    await expect.poll(active).toBe('Manage account')

    const link = byLabel('Manage account') as HTMLAnchorElement
    let defaultPrevented: boolean | null = null
    // the anchor's href opens a tab, so the click is caught here rather than followed
    link.addEventListener('click', (e) => { defaultPrevented = true; e.preventDefault() }, { once: true })
    await userEvent.keyboard(' ')
    await expect.poll(() => defaultPrevented).toBe(true)
  })

  it('still activates the button row with Space', async () => {
    await mounted()
    await openMenu()
    await userEvent.keyboard('{ArrowUp}')
    await expect.poll(active).toBe('Disconnect')
    await userEvent.keyboard(' ')
    await expect.poll(() => account.logout.mock.calls.length).toBe(1)
  })
})
