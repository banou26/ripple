import { expect, test } from 'vitest'

test('browser tests run in en-US, whatever the machine\'s own locale', () => {
  expect(navigator.languages).toEqual(['en-US'])
  expect(new Intl.NumberFormat().resolvedOptions().locale).toBe('en-US')
})
