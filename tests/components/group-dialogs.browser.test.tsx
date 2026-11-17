import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { GroupNameDialog } from '../../src/components/group-dialogs'
import { IntlRoot } from '../../src/i18n'

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
    expect(props.onSave).toHaveBeenCalledWith('Week 2')
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
    expect(props.onSave).toHaveBeenCalledWith('Week 2 b')
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
