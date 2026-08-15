import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { useState } from 'react'

import { useConfirm } from './confirm-dialog'

/**
 * The guard in front of an irreversible action, so its failure modes are the interesting part.
 *
 * A confirmation that never settles hangs the caller forever, and a confirmation that defaults to
 * the destructive answer is worse than none at all. Both are asserted here rather than assumed.
 */

const REMEMBER_KEY = 'ripple:test-confirm'

const Harness = ({ rememberKey }: { rememberKey?: string }) => {
  const { confirm, confirmElement, confirmOpen } = useConfirm()
  const [result, setResult] = useState<string>('pending')
  return (
    <div>
      {confirmElement}
      <button
        onClick={async () => {
          setResult('pending')
          const ok = await confirm({
            title: 'Remove Some.Release?',
            body: 'This deletes the 1.4 GB already downloaded.',
            confirmLabel: 'Remove and delete',
            tone: 'danger',
            rememberKey,
          })
          setResult(ok ? 'confirmed' : 'cancelled')
        }}
      >
        Ask
      </button>
      <span data-testid="result">{result}</span>
      <span data-testid="open">{String(confirmOpen)}</span>
    </div>
  )
}

describe('the confirmation in front of a destructive action', () => {
  afterEach(() => { localStorage.removeItem(REMEMBER_KEY) })

  it('states the consequence, not just the question', async () => {
    const screen = await render(<Harness />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await expect.element(screen.getByText('Remove Some.Release?')).toBeInTheDocument()
    // the size at risk is the whole point of the line
    await expect.element(screen.getByText(/deletes the 1\.4 GB already downloaded/)).toBeInTheDocument()
  })

  it('resolves true only when the destructive button is pressed', async () => {
    const screen = await render(<Harness />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await screen.getByRole('button', { name: 'Remove and delete' }).click()
    await expect.element(screen.getByTestId('result')).toHaveTextContent('confirmed')
  })

  it('resolves false on Cancel', async () => {
    const screen = await render(<Harness />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await screen.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(screen.getByTestId('result')).toHaveTextContent('cancelled')
  })

  /**
   * Esc fires the dialog's `cancel` event, NOT a click on anything. A handler that only settles from
   * the two buttons leaves the caller awaiting a promise that can never resolve, and the symptom is
   * a Remove that silently does nothing ever again.
   */
  it('settles when dismissed with Escape rather than hanging the caller', async () => {
    const screen = await render(<Harness />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    // a portal to the body, and no longer a <dialog>, so it is found by role in the document rather
    // than by tag inside the render container
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()

    // Escape is handled by the shell's own keydown now, where <dialog> used to raise 'cancel'
    await userEvent.keyboard('{Escape}')

    await expect.element(screen.getByTestId('result')).toHaveTextContent('cancelled')
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull()
  })

  /**
   * A stray Enter must not destroy anything, so the safe action holds focus.
   *
   * Asserted WITH a remember key, because that is the configuration Remove actually ships and it is
   * the one that broke: showModal focuses the first focusable descendant absent an autofocus
   * attribute, and the "Don't ask again" checkbox precedes both buttons in the tree. Testing only
   * the checkbox-less variant passed against a dialog that focused the checkbox in production.
   */
  it.each([
    ['without a remember key', undefined],
    ['with a remember key, the shipping shape', REMEMBER_KEY],
  ])('puts focus on Cancel %s', async (_label, key) => {
    const screen = await render(<Harness rememberKey={key} />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await expect.poll(() => document.activeElement?.textContent).toBe('Cancel')
  })

  it('does not offer to be silenced unless a remember key is given', async () => {
    const screen = await render(<Harness />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    expect(screen.container.querySelector('input[type=checkbox]')).toBeNull()
  })

  /**
   * The remembered answer is only recorded when the user CONFIRMED with the box ticked. Recording it
   * on cancel would silence the dialog while the user was declining the action.
   */
  it('remembers a ticked confirmation and skips the next one', async () => {
    const screen = await render(<Harness rememberKey={REMEMBER_KEY} />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await screen.getByRole('checkbox').click()
    await screen.getByRole('button', { name: 'Remove and delete' }).click()
    await expect.element(screen.getByTestId('result')).toHaveTextContent('confirmed')
    expect(localStorage.getItem(REMEMBER_KEY)).toBe('skip')

    // second time it must not even render, and must still answer true
    await screen.getByRole('button', { name: 'Ask' }).click()
    await expect.element(screen.getByTestId('result')).toHaveTextContent('confirmed')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not remember a ticked box when the user cancels', async () => {
    const screen = await render(<Harness rememberKey={REMEMBER_KEY} />)
    await screen.getByRole('button', { name: 'Ask' }).click()
    await screen.getByRole('checkbox').click()
    await screen.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(screen.getByTestId('result')).toHaveTextContent('cancelled')
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull()
  })
})
