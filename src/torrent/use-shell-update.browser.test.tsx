import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * What ripple does when somebody takes an FKN shell update.
 *
 * It reloads. The update reaches every open page, not only the one where the button was pressed, and
 * a tab left on the old document against the new shell is the thing this exists to prevent.
 *
 * Two failures worth pinning:
 *
 *  - the handler never registers, so nothing here decides anything and the behaviour is whatever
 *    `@fkn/lib` happens to default to. Silent: nothing throws.
 *  - it registers and then does not reload, which is the same outcome by a longer route. This is
 *    what the code used to do on purpose while a transfer was running, so it is a real regression
 *    shape rather than a hypothetical one.
 *
 * The real thing ends in `location.reload()`, which a test cannot let happen, so the reload module
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

// `location` itself cannot be stubbed in a real browser, which is why the reload has its own module
const reloads: string[] = []
vi.mock('../utils/reload', () => ({ reloadPage: () => { reloads.push('reload') } }))

const { useShellUpdate } = await import('./use-shell-update')

const Harness = () => {
  useShellUpdate()
  return <div data-testid="mounted">mounted</div>
}

beforeEach(() => {
  taken = null
  unsubscribed = 0
  reloads.length = 0
})

describe('an FKN update taken while ripple is open', () => {
  it('registers a handler, which is what makes the decision ripple\'s', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
  })

  it('reloads the page', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    taken!()
    await expect.poll(() => reloads.length).toBe(1)
  })

  /**
   * The behaviour that changed, pinned so it cannot quietly change back.
   *
   * A page with a live download used to hold off and show a banner. It reloads now: the bytes are in
   * OPFS and the torrent resumes, so the interruption is the whole cost, and a tab on a stale
   * document is worse. Firing twice also proves the handler is not a one-shot.
   */
  it('reloads even when the page has been running for a while', async () => {
    render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    taken!()
    taken!()
    await expect.poll(() => reloads.length).toBe(2)
  })

  it('lets go of the handler when the page unmounts', async () => {
    const screen = await render(<Harness/>)
    await expect.poll(() => taken).not.toBeNull()
    screen.unmount()
    await expect.poll(() => unsubscribed).toBe(1)
  })
})
