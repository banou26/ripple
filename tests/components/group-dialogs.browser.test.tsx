import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { GroupLinkDialog, GroupNameDialog } from '../../src/components/group-dialogs'
import { IntlRoot } from '../../src/i18n'
import ru from '../../src/locales/ru.json'
import { showEnglish, showIn } from '../i18n/show-in'

const open = async (name?: string) => {
  const props = { title: name ?? 'New group', name, onCancel: vi.fn(), onSave: vi.fn() }
  await render(<IntlRoot><GroupNameDialog {...props}/></IntlRoot>)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  return {
    props,
    dialog,
    field: dialog.querySelector('input')!,
    save: [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')!,
    cancel: [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!,
  }
}

describe('naming a group', () => {
  it('asks for a name in a field that has the focus, and saves it trimmed once there is one', async () => {
    const { props, dialog, field, save } = await open()
    expect(dialog).toHaveAccessibleName('New group')
    expect(field).toHaveAccessibleName('Name')
    expect(document.activeElement).toBe(field)
    expect(save.disabled).toBe(true)
    await userEvent.type(field, '   ')
    expect(save.disabled, 'a name of spaces').toBe(true)
    await userEvent.type(field, ' Week 2 {Enter}')
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Week 2', icon: { kind: 'default' }, imageFile: null })
    expect(field.getAttribute('dir')).toBe('auto')
  })

  it('renames under the group\'s own name, offering Save only once the name changes', async () => {
    const { props, dialog, field, save } = await open('Week 2')
    expect(dialog).toHaveAccessibleName('Week 2')
    expect(field.value).toBe('Week 2')
    expect(save.disabled).toBe(true)
    await userEvent.type(field, ' ')
    expect(save.disabled, 'the same name with a space after it').toBe(true)
    await userEvent.type(field, 'b')
    expect(save.disabled).toBe(false)
    save.click()
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Week 2 b', icon: { kind: 'default' }, imageFile: null })
  })

  it('enables Save when picking a preset icon without changing the name', async () => {
    const { props, dialog, save } = await open('Week 2')
    expect(save.disabled).toBe(true)
    const filmButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="Film icon"]')!
    filmButton.click()
    await expect.poll(() => save.disabled).toBe(false)
    expect(filmButton.getAttribute('aria-pressed')).toBe('true')
    save.click()
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Week 2', icon: { kind: 'preset', icon: 'film' }, imageFile: null })
  })

  it('titles a rename in the direction of the name\'s own words', async () => {
    const { dialog } = await open('סדרה!')
    expect(dialog).toHaveAccessibleName('סדרה!')
    expect(getComputedStyle(dialog.querySelector('h2')!).direction).toBe('rtl')
  })

  it('saves nothing on Cancel or Escape', async () => {
    const { props, field, cancel } = await open()
    await userEvent.type(field, 'Week 2')
    cancel.click()
    await userEvent.keyboard('{Escape}')
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    expect(props.onSave).not.toHaveBeenCalled()
  })
})

const received = async (name: string, count: number) => {
  const props = { name, count, onCancel: vi.fn(), onAdd: vi.fn() }
  await render(<IntlRoot><GroupLinkDialog {...props}/></IntlRoot>)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  const button = (text: string) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === text)!
  return { props, dialog, add: button('Add'), cancel: button('Cancel') }
}

describe('a group sent by link', () => {
  afterEach(showEnglish)

  it('is named as its sender named it, says how many torrents it holds, and adds only on Add', async () => {
    const { props, dialog, add, cancel } = await received('Week 2', 3)
    expect(dialog).toHaveAccessibleName('Week 2')
    expect(dialog.querySelector('p')).toBeVisible()
    expect(dialog.querySelector('p')?.textContent).toBe('3 torrents')
    // the proposal is someone else's, so Enter does not take it
    expect(document.activeElement).toBe(cancel)
    cancel.click()
    await userEvent.keyboard('{Escape}')
    expect(props.onCancel).toHaveBeenCalledTimes(2)
    expect(props.onAdd).not.toHaveBeenCalled()
    add.click()
    expect(props.onAdd).toHaveBeenCalledTimes(1)
  })

  it('draws a name in the direction of its own words, since a stranger chose it', async () => {
    const { dialog } = await received('סדרה!', 1)
    expect(getComputedStyle(dialog.querySelector('h2')!).direction).toBe('rtl')
    expect(dialog.querySelector('p')?.textContent).toBe('1 torrent')
  })

  it('counts in the language of the page', async () => {
    await showIn('ru', ru)
    const { dialog } = await received('Неделя 2', 5)
    expect(dialog.querySelector('p')?.textContent).toBe('5 торрентов')
  })
})
