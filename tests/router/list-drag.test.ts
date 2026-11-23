import { describe, expect, it } from 'vitest'

import { canDropInto, computeDropPlace, decodeDrag, encodeDrag } from '../../src/router/list-drag'

describe('list-drag', () => {
  it('encodes and decodes top-level and group member drag payloads', () => {
    const top = { kind: 'top' as const, key: 't:abc' as const }
    const member = { kind: 'member' as const, groupId: 'g1', infoHash: 'abc' }
    expect(decodeDrag(encodeDrag(top))).toEqual(top)
    expect(decodeDrag(encodeDrag(member))).toEqual(member)
    expect(decodeDrag('')).toBeNull()
    expect(decodeDrag('not json')).toBeNull()
    expect(decodeDrag(JSON.stringify({ kind: 'top', key: 'bad' }))).toBeNull()
    expect(decodeDrag(JSON.stringify({ kind: 'member', groupId: '', infoHash: 'abc' }))).toBeNull()
  })

  it('splits drop zones cleanly whether into is enabled or disabled', () => {
    const rect = { top: 100, height: 100 }
    expect(computeDropPlace(110, rect, false)).toBe('before')
    expect(computeDropPlace(190, rect, false)).toBe('after')
    expect(computeDropPlace(110, rect, true)).toBe('before')
    expect(computeDropPlace(150, rect, true)).toBe('into')
    expect(computeDropPlace(190, rect, true)).toBe('after')
  })

  it('controls mobile-folder drop targets without self-drops or group nesting', () => {
    const looseA = { kind: 'top' as const, key: 't:aaa' as const }
    const groupDrag = { kind: 'top' as const, key: 'g:g1' as const }
    const memberDrag = { kind: 'member' as const, groupId: 'g1', infoHash: 'aaa' }

    expect(canDropInto(looseA, 't:bbb', true)).toBe(true)
    expect(canDropInto(looseA, 't:aaa', true)).toBe(false)
    expect(canDropInto(groupDrag, 't:bbb', true)).toBe(false)
    expect(canDropInto(groupDrag, 'g:g2', true)).toBe(false)
    expect(canDropInto(looseA, 'g:g1', true)).toBe(true)
    expect(canDropInto(memberDrag, 'g:g2', true)).toBe(true)
    expect(canDropInto(memberDrag, 'g:g1', true)).toBe(false)
    expect(canDropInto(memberDrag, 't:bbb', true)).toBe(true)
    expect(canDropInto(memberDrag, 't:aaa', true)).toBe(false)
    expect(canDropInto(looseA, 'child:g1:bbb', false)).toBe(false)
    expect(canDropInto(null, 't:bbb', true)).toBe(true)
    expect(canDropInto(null, 'child:g1:bbb', false)).toBe(false)
  })
})
