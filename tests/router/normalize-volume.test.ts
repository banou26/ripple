import { describe, expect, it } from 'vitest'

import { NORMALIZE_VOLUME_KEY, normalizeVolumeSaved } from '../../src/router/normalize-volume'

describe('the saved volume normalizer switch', () => {
  it('is off until it was turned on, and on only for the exact stored value', () => {
    const stored = (value: string | null) => (key: string) => (key === NORMALIZE_VOLUME_KEY ? value : null)
    expect(normalizeVolumeSaved(stored(null))).toBe(false)
    expect(normalizeVolumeSaved(stored('0'))).toBe(false)
    expect(normalizeVolumeSaved(stored('true'))).toBe(false)
    expect(normalizeVolumeSaved(stored('1'))).toBe(true)
  })

  it('is off where storage cannot be read', () => {
    expect(normalizeVolumeSaved(() => { throw new DOMException('blocked', 'SecurityError') })).toBe(false)
  })
})
