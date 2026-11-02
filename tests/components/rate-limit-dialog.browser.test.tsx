import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { RateLimitDialog } from '../../src/components/rate-limit-dialog'
import { IntlRoot } from '../../src/i18n'
import fr from '../../src/locales/fr.json'
import ko from '../../src/locales/ko.json'
import { showEnglish, showIn } from '../i18n/show-in'

/**
 * The one place a speed ceiling is typed, for both the session-wide pair and a single torrent.
 *
 * Two things here are worth a test rather than a glance. The field is kB/s and the engine takes bytes
 * per second, so every value crosses a conversion on the way out, and an off-by-1000 there is a
 * setting that appears to work and throttles a thousand times too hard. And 0 is how "unlimited" is
 * stored, which means an EMPTY field and an unlimited one have to stay distinguishable: reading a
 * half-typed field as 0 would silently remove a limit somebody was in the middle of changing.
 */

const apply = (props: Partial<Parameters<typeof RateLimitDialog>[0]> = {}) => {
  const onApply = vi.fn()
  const onCancel = vi.fn()
  render(
    <RateLimitDialog
      title="Download rate limit"
      onApply={onApply}
      onCancel={onCancel}
      {...props}
    />,
    { wrapper: IntlRoot },
  )
  return { onApply, onCancel }
}

const field = () => document.querySelector('input[type="number"]') as HTMLInputElement
const unlimitedBox = () => document.querySelector('input[type="checkbox"]') as HTMLInputElement
const submit = () => document.querySelector('button[type="submit"]') as HTMLButtonElement

describe('opening on what is already set', () => {
  it('shows an existing ceiling in kB/s, not in bytes', async () => {
    apply({ value: 2_000_000 })
    await expect.poll(() => field()?.value).toBe('2000')
    expect(unlimitedBox().checked).toBe(false)
  })

  /** Absent and 0 are different in storage and identical here: neither is a limit. */
  it('opens with Unlimited ticked for a torrent that has no ceiling', async () => {
    apply({ value: undefined })
    await expect.poll(() => unlimitedBox()?.checked).toBe(true)
    expect(field().disabled).toBe(true)
  })

  it('opens with Unlimited ticked for one deliberately set to 0', async () => {
    apply({ value: 0 })
    await expect.poll(() => unlimitedBox()?.checked).toBe(true)
  })

  it('names what is being limited when it is one torrent', async () => {
    apply({ subject: 'Sintel.2010.1080p' })
    await expect.poll(() => document.body.textContent).toContain('Sintel.2010.1080p')
  })
})

describe('what comes back out', () => {
  /** The whole conversion, in one assertion. A thousand-fold error here is invisible on screen. */
  it('hands back bytes per second for a value typed in kB/s', async () => {
    const { onApply } = apply({ value: undefined })
    await expect.poll(unlimitedBox).not.toBeNull()
    await userEvent.click(unlimitedBox())
    await userEvent.fill(field(), '250')
    await userEvent.click(submit())
    expect(onApply).toHaveBeenCalledWith(250_000)
  })

  it('takes a fractional rate rather than refusing it', async () => {
    const { onApply } = apply({ value: 1_000_000 })
    await expect.poll(() => field()?.value).toBe('1000')
    await userEvent.fill(field(), '1.5')
    await userEvent.click(submit())
    expect(onApply).toHaveBeenCalledWith(1500)
  })

  it('sends 0 for unlimited, which is how the engine is told to stop capping', async () => {
    const { onApply } = apply({ value: 2_000_000 })
    await expect.poll(unlimitedBox).not.toBeNull()
    await userEvent.click(unlimitedBox())
    await userEvent.click(submit())
    expect(onApply).toHaveBeenCalledWith(0)
  })

  it('closes without applying anything on Escape', async () => {
    const { onApply, onCancel } = apply({ value: 2_000_000 })
    await expect.poll(field).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('refusing what it cannot read', () => {
  /**
   * The failure this prevents: someone clears the field meaning to retype it, changes their mind and
   * hits the button. Reading empty as 0 would take the limit off, which is the opposite of what they
   * were doing, and nothing on screen would say so.
   */
  it('will not commit an empty field, which is not the same as unlimited', async () => {
    apply({ value: 2_000_000 })
    await expect.poll(() => field()?.value).toBe('2000')
    await userEvent.fill(field(), '')
    await expect.poll(() => submit()?.disabled).toBe(true)
    expect(submit().textContent).toBe('Limit to Unlimited')
    expect(document.body.textContent).toContain('or tick Unlimited')
  })

  it('recovers when the box is unticked over an empty field, rather than opening its own error', async () => {
    apply({ value: undefined })
    await expect.poll(unlimitedBox).not.toBeNull()
    await userEvent.click(unlimitedBox())
    await expect.poll(() => submit()?.disabled).toBe(false)
  })
})

/**
 * libtorrent accepts a per-torrent ceiling above the session one and then ignores it, because a
 * torrent can never exceed the global limit. Nothing observable says so, which is why this line is
 * the only thing between the user and a control that looks broken.
 */
describe('saying when the session limit is what really binds', () => {
  it('shows the warning it was given', async () => {
    apply({ value: 5_000_000, note: 'Capped at 1 MB/s by the total limit.' })
    await expect.poll(() => document.body.textContent).toContain('Capped at 1 MB/s')
  })

  it('drops the warning once the field says unlimited, where it no longer applies', async () => {
    apply({ value: 5_000_000, note: 'Capped at 1 MB/s by the total limit.' })
    await expect.poll(() => document.body.textContent).toContain('Capped at')
    await userEvent.click(unlimitedBox())
    await expect.poll(() => document.body.textContent).not.toContain('Capped at')
  })
})

describe('in the language of the page', () => {
  afterEach(showEnglish)

  it('words its field, its box, its buttons and its refusal, with the speed in the page\'s units', async () => {
    await showIn('fr', fr, 'fr-FR')
    apply({ title: 'Limite de réception', value: 2_000_000 })
    await expect.poll(() => submit()?.textContent?.replace(/\s/gu, ' ')).toBe('Limiter à 2 Mo/s')
    expect(field().getAttribute('aria-label')).toBe('Limite de réception, en kilooctets par seconde')
    expect(document.querySelector('.unit')?.textContent).toBe('ko/s')
    expect(document.querySelector('label.check')?.textContent).toBe('Illimité')
    expect(document.querySelector('.actions button')?.textContent).toBe('Annuler')
    await userEvent.fill(field(), '')
    await expect.poll(() => document.querySelector('.problem')?.textContent).toBe('Saisissez une vitesse en ko/s ou cochez Illimité.')
    await userEvent.click(unlimitedBox())
    await expect.poll(() => submit()?.textContent).toBe('Retirer la limite')
  })

  /** Korean joins Unlimited with 으로 where a speed takes 로, so Unlimited put in place of a speed reads wrong. */
  it('words the empty field\'s button as a whole, not as a speed', async () => {
    await showIn('ko', ko, 'ko-KR')
    apply({ title: '다운로드 속도 제한', value: 2_000_000 })
    await expect.poll(() => submit()?.textContent).toMatch(/^2\s?MB\/s로 제한$/u)
    await userEvent.fill(field(), '')
    await expect.poll(() => submit()?.textContent).toBe('무제한으로 제한')
  })
})
