import { expect, test } from 'vitest'

import config from '../../playwright.config'

// ripple's text, dates and numbers follow the browser's language, so every runner pins the same one

test('unit tests run in en-US, whatever the runner\'s own locale', () => {
  expect(navigator.languages).toEqual(['en-US'])
  expect(new Intl.NumberFormat().resolvedOptions().locale).toBe('en-US')
})

test('the Playwright suite\'s browsers run in en-US', () => {
  expect(config.use?.locale).toBe('en-US')
})
