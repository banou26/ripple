import type { OrderKey } from '../torrent/list-order'

/** Dedicated MIME type so internal row drags never trip the page-wide .torrent/magnet drop overlay. */
export const ROW_DRAG_MIME = 'application/x-ripple-row'

export type DragPayload =
  | { kind: 'top', key: OrderKey }
  | { kind: 'member', groupId: string, infoHash: string }

export type DropPlace = 'before' | 'after' | 'into'

export type DropIndicator = {
  targetKey: string
  place: DropPlace
} | null

export const encodeDrag = (payload: DragPayload): string => JSON.stringify(payload)

export const decodeDrag = (raw: string | null | undefined): DragPayload | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind === 'top' && typeof parsed.key === 'string' && (parsed.key.startsWith('g:') || parsed.key.startsWith('t:'))) {
      return { kind: 'top', key: parsed.key as OrderKey }
    }
    if (parsed.kind === 'member' && typeof parsed.groupId === 'string' && parsed.groupId && typeof parsed.infoHash === 'string' && parsed.infoHash) {
      return { kind: 'member', groupId: parsed.groupId, infoHash: parsed.infoHash }
    }
    return null
  } catch {
    return null
  }
}

export const canDropInto = (payload: DragPayload | null, targetKey: string, allowInto: boolean): boolean => {
  if (!allowInto) return false
  if (!payload) return true
  if (payload.kind === 'top') return payload.key.startsWith('t:') && payload.key !== targetKey
  return targetKey !== `g:${payload.groupId}` && targetKey !== `t:${payload.infoHash}`
}

export const computeDropPlace = (clientY: number, rect: Pick<DOMRect, 'top' | 'height'>, allowInto: boolean): DropPlace => {
  const height = Math.max(1, rect.height)
  const ratio = (clientY - rect.top) / height
  if (!allowInto) return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'into'
}
