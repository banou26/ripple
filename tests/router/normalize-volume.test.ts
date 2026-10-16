import { describe, expect, it } from 'vitest'

import { NORMALIZE_VOLUME_KEY, normalizeVolumeSaved } from '../../src/router/normalize-volume'

describe('the saved volume normalizer switch', () => {
  it('is on until it was turned off, and off only for the exact stored value', () => {
    const stored = (value: string | null) => (key: string) => (key === NORMALIZE_VOLUME_KEY ? value : null)
    expect(normalizeVolumeSaved(stored(null))).toBe(true)
    expect(normalizeVolumeSaved(stored('1'))).toBe(true)
    expect(normalizeVolumeSaved(stored('false'))).toBe(true)
    expect(normalizeVolumeSaved(stored('0'))).toBe(false)
  })

  it('is on where storage cannot be read', () => {
    expect(normalizeVolumeSaved(() => { throw new DOMException('blocked', 'SecurityError') })).toBe(true)
  })
})
