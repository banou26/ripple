import { describe, expect, it } from 'vitest'

import type { GroupAppearance } from '../../src/torrent/group-appearance'

import { DEFAULT_ICON, PRESET_ICONS, groupImageKey, mergeAppearance } from '../../src/torrent/group-appearance'

const HASH_A = '0123456789abcdef'
const HASH_B = 'fedcba9876543210'

describe('group appearance metadata', () => {
  it('merges valid presets and image hashes by latest updatedAt', () => {
    const earlier: GroupAppearance = { id: 'g1', icon: { kind: 'preset', icon: 'film' }, updatedAt: 10 }
    const later: GroupAppearance = { id: 'g1', icon: { kind: 'image', hash: HASH_A }, updatedAt: 20 }
    const reset: GroupAppearance = { id: 'g2', icon: DEFAULT_ICON, updatedAt: 5 }

    expect(mergeAppearance([earlier], [later, reset])).toEqual([later, reset])
    expect(mergeAppearance([later], [earlier])).toEqual([later])
  })

  it('drops invalid icon kinds, unknown presets, and malformed hashes', () => {
    const merged = mergeAppearance([
      { id: 'bad1', icon: { kind: 'preset', icon: 'not-an-icon' }, updatedAt: 10 },
      { id: 'bad2', icon: { kind: 'image', hash: 'too-short' }, updatedAt: 10 },
      { id: '', icon: { kind: 'preset', icon: 'star' }, updatedAt: 10 },
      { id: 'ok', icon: { kind: 'preset', icon: PRESET_ICONS[0] }, updatedAt: 10 },
    ])
    expect(merged).toEqual([{ id: 'ok', icon: { kind: 'preset', icon: 'folder' }, updatedAt: 10 }])
  })

  it('breaks equal updatedAt ties deterministically regardless of source order', () => {
    const a: GroupAppearance = { id: 'g1', icon: { kind: 'image', hash: HASH_A }, updatedAt: 50 }
    const b: GroupAppearance = { id: 'g1', icon: { kind: 'image', hash: HASH_B }, updatedAt: 50 }
    expect(mergeAppearance([a], [b])).toEqual(mergeAppearance([b], [a]))
  })

  it('builds content-addressed group image cache keys', () => {
    expect(groupImageKey('g1', HASH_A)).toBe(`group:g1:${HASH_A}`)
  })
})
