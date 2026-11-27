import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { GroupEntry, LibraryEntry } from '../torrent/group-rows'
import type { TorrentGroup } from '../torrent/groups'
import type { ListOrder, OrderKey } from '../torrent/list-order'

import { groupMemberKeys, visibleTopKeys } from '../torrent/group-rows'
import { reorderKeys } from '../torrent/list-order'

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

export type RowDragActions = {
  onStart: (payload: DragPayload, key: string, e: ReactDragEvent) => void
  onEnd: () => void
  onOver: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  onLeave: (targetKey: string) => void
  onDrop: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  onKeyDown?: (payload: DragPayload, e: ReactKeyboardEvent) => void
  isDraggingActive?: () => boolean
}

export const rowDragAttrs = ({
  dragActions, dragKey, payload, allowInto, isDragging, dropPlace,
}: {
  dragActions?: RowDragActions
  dragKey?: string
  payload: DragPayload | null
  allowInto: boolean
  isDragging?: boolean
  dropPlace?: DropPlace
}) => (
  dragKey && dragActions
    ? {
      draggable: payload !== null,
      tabIndex: payload !== null ? 0 : undefined,
      'data-dragging': isDragging || undefined,
      'data-drop': dropPlace || undefined,
      onDragStart: payload ? (e: ReactDragEvent) => dragActions.onStart(payload, dragKey, e) : undefined,
      onDragEnd: dragActions.onEnd,
      onTouchCancel: dragActions.onEnd,
      // WebKit cancels the drop if the target only listens to dragover without calling preventDefault() on dragenter.
      onDragEnter: (e: ReactDragEvent) => dragActions.onOver(dragKey, allowInto, e),
      onDragOver: (e: ReactDragEvent) => dragActions.onOver(dragKey, allowInto, e),
      onDragLeave: () => dragActions.onLeave(dragKey),
      onDrop: (e: ReactDragEvent) => dragActions.onDrop(dragKey, allowInto, e),
      onKeyDown: payload && dragActions.onKeyDown ? (e: ReactKeyboardEvent) => dragActions.onKeyDown?.(payload, e) : undefined,
    }
    : {}
)

export const encodeDrag = (payload: DragPayload): string => JSON.stringify(payload)

export const decodeDrag = (raw: string | null | undefined): DragPayload | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload> | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind === 'top' && typeof parsed.key === 'string' && (parsed.key.startsWith('g:') || parsed.key.startsWith('t:'))) {
      return { kind: 'top', key: parsed.key }
    }
    if (parsed.kind === 'member' && typeof parsed.groupId === 'string' && parsed.groupId && typeof parsed.infoHash === 'string' && parsed.infoHash) {
      return { kind: 'member', groupId: parsed.groupId, infoHash: parsed.infoHash }
    }
    return null
  } catch {
    return null
  }
}

export const parseChildKey = (targetKey: string): { groupId: string, infoHash: string } | null => {
  if (!targetKey.startsWith('child:')) return null
  const rest = targetKey.slice('child:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const groupId = rest.slice(0, sep)
  const infoHash = rest.slice(sep + 1)
  return groupId && infoHash ? { groupId, infoHash } : null
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

export type DropAction =
  | { kind: 'new-group', targetHash: string, draggedHash: string, removeFromGroupId?: string }
  | { kind: 'add-to-group', groupId: string, infoHash: string }
  | { kind: 'move-between-groups', fromGroupId: string | undefined, toGroupId: string, infoHash: string, membersOrder?: string[] }
  | { kind: 'reorder-members', groupId: string, members: string[] }
  | { kind: 'reorder-top', top: OrderKey[], removeFromGroup?: { groupId: string, infoHash: string } }

/**
 * Resolves a drop into a validated action, verifying both source and target hashes/groups belong
 * to the active library entries and groups before trusting anything read from `dataTransfer`.
 */
export const resolveDrop = ({
  payload,
  targetKey,
  place,
  entries,
  groups,
  listOrder,
}: {
  payload: DragPayload
  targetKey: string
  place: DropPlace
  entries: readonly LibraryEntry[]
  groups: readonly TorrentGroup[]
  listOrder: ListOrder
}): DropAction | null => {
  const entryByKey = new Map(entries.map((e) => [e.key, e]))
  const activeGroups = new Map(groups.filter((g) => !g.deletedAt).map((g) => [g.id, g]))
  const groupEntryById = new Map(
    entries
      .filter((e): e is GroupEntry => e.kind === 'group')
      .map((e) => [e.group.id, e]),
  )
  const looseHashes = new Set(
    entries.flatMap((e) => (e.kind === 'torrent' && e.torrent.infoHash ? [e.torrent.infoHash] : [])),
  )

  // Validate source identity against active library entries/groups
  if (payload.kind === 'top') {
    if (!entryByKey.has(payload.key)) return null
    if (payload.key.startsWith('g:') && !activeGroups.has(payload.key.slice(2))) return null
    if (payload.key.startsWith('t:') && !looseHashes.has(payload.key.slice(2))) return null
  } else {
    if (!activeGroups.has(payload.groupId)) return null
    const srcGroup = groupEntryById.get(payload.groupId)
    if (!srcGroup || !groupMemberKeys(srcGroup.summary).includes(payload.infoHash)) return null
  }

  // Validate target key identity against active library entries/groups
  let targetChild: { groupId: string, infoHash: string, parent: GroupEntry } | undefined
  if (targetKey.startsWith('t:')) {
    if (!entryByKey.has(targetKey as OrderKey) || !looseHashes.has(targetKey.slice(2))) return null
  } else if (targetKey.startsWith('g:')) {
    const gid = targetKey.slice(2)
    if (!entryByKey.has(targetKey as OrderKey) || !activeGroups.has(gid)) return null
  } else if (targetKey.startsWith('child:')) {
    const child = parseChildKey(targetKey)
    if (!child || !activeGroups.has(child.groupId)) return null
    const parent = groupEntryById.get(child.groupId)
    if (!parent || !groupMemberKeys(parent.summary).includes(child.infoHash)) return null
    targetChild = { ...child, parent }
  } else {
    return null
  }

  if (payload.kind === 'top') {
    if (targetKey.startsWith('t:') && place === 'into' && payload.key.startsWith('t:') && targetKey !== payload.key) {
      return { kind: 'new-group', targetHash: targetKey.slice(2), draggedHash: payload.key.slice(2) }
    }
    if (targetKey.startsWith('g:') && place === 'into' && payload.key.startsWith('t:')) {
      return { kind: 'add-to-group', groupId: targetKey.slice(2), infoHash: payload.key.slice(2) }
    }
    if (targetChild && payload.key.startsWith('t:')) {
      const draggedHash = payload.key.slice(2)
      const visibleMembers = groupMemberKeys(targetChild.parent.summary)
      const existingMembers = listOrder.groups[targetChild.groupId]?.members ?? []
      return {
        kind: 'move-between-groups',
        fromGroupId: undefined,
        toGroupId: targetChild.groupId,
        infoHash: draggedHash,
        membersOrder: reorderKeys([...visibleMembers, draggedHash], existingMembers, draggedHash, targetChild.infoHash, place === 'before' ? 'before' : 'after'),
      }
    }
    if ((targetKey.startsWith('g:') || targetKey.startsWith('t:')) && targetKey !== payload.key) {
      return {
        kind: 'reorder-top',
        top: reorderKeys(visibleTopKeys(entries), listOrder.top, payload.key, targetKey as OrderKey, place === 'before' ? 'before' : 'after'),
      }
    }
    return null
  }

  // payload.kind === 'member'
  if (targetKey.startsWith(`child:${payload.groupId}:`)) {
    if (!targetChild || targetChild.infoHash === payload.infoHash) return null
    const visibleMembers = groupMemberKeys(targetChild.parent.summary)
    const existingMembers = listOrder.groups[payload.groupId]?.members ?? []
    return {
      kind: 'reorder-members',
      groupId: payload.groupId,
      members: reorderKeys(visibleMembers, existingMembers, payload.infoHash, targetChild.infoHash, place === 'before' ? 'before' : 'after'),
    }
  }
  if (targetChild) {
    const visibleMembers = groupMemberKeys(targetChild.parent.summary)
    const existingMembers = listOrder.groups[targetChild.groupId]?.members ?? []
    return {
      kind: 'move-between-groups',
      fromGroupId: payload.groupId,
      toGroupId: targetChild.groupId,
      infoHash: payload.infoHash,
      membersOrder: reorderKeys([...visibleMembers, payload.infoHash], existingMembers, payload.infoHash, targetChild.infoHash, place === 'before' ? 'before' : 'after'),
    }
  }
  if (targetKey.startsWith('g:')) {
    const targetGroupId = targetKey.slice(2)
    if (targetGroupId === payload.groupId) return null
    if (place === 'into') {
      return { kind: 'move-between-groups', fromGroupId: payload.groupId, toGroupId: targetGroupId, infoHash: payload.infoHash }
    }
    return {
      kind: 'reorder-top',
      top: reorderKeys(visibleTopKeys(entries), listOrder.top, `t:${payload.infoHash}`, targetKey as OrderKey, place),
      removeFromGroup: { groupId: payload.groupId, infoHash: payload.infoHash },
    }
  }
  if (targetKey.startsWith('t:')) {
    if (place === 'into') {
      const targetHash = targetKey.slice(2)
      if (targetHash === payload.infoHash) return null
      return { kind: 'new-group', targetHash, draggedHash: payload.infoHash, removeFromGroupId: payload.groupId }
    }
    return {
      kind: 'reorder-top',
      top: reorderKeys(visibleTopKeys(entries), listOrder.top, `t:${payload.infoHash}`, targetKey as OrderKey, place === 'before' ? 'before' : 'after'),
      removeFromGroup: { groupId: payload.groupId, infoHash: payload.infoHash },
    }
  }
  return null
}

/** Replaces `t:targetHash` with `g:groupId` and removes `t:draggedHash` when custom top order is active. */
export const buildNewGroupTopOrder = (
  entries: readonly LibraryEntry[],
  currentTop: readonly OrderKey[],
  targetHash: string,
  draggedHash: string,
  groupId: string,
): OrderKey[] | null => {
  if (currentTop.length === 0) return null
  const base = currentTop.includes(`t:${targetHash}`) ? currentTop : visibleTopKeys(entries)
  return base.flatMap((key) => (key === `t:${targetHash}` ? [`g:${groupId}` as const] : key === `t:${draggedHash}` ? [] : [key]))
}

/**
 * Computes the updated top or member order when stepping `target` one slot `up` or `down`,
 * or `null` when already at the boundary or not found.
 */
export const moveEntryByStep = ({
  target,
  direction,
  entries,
  listOrder,
  topKeys,
}: {
  target: DragPayload
  direction: 'up' | 'down'
  entries: readonly LibraryEntry[]
  listOrder: ListOrder
  topKeys?: readonly OrderKey[]
}): { kind: 'top', top: OrderKey[] } | { kind: 'members', groupId: string, members: string[] } | null => {
  if (target.kind === 'top') {
    const visible = topKeys ? [...topKeys] : visibleTopKeys(entries)
    const idx = visible.indexOf(target.key)
    if (idx < 0) return null
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    const neighbor = visible[swapIdx]
    if (!neighbor) return null
    return {
      kind: 'top',
      top: reorderKeys(visibleTopKeys(entries), listOrder.top, target.key, neighbor, direction === 'up' ? 'before' : 'after'),
    }
  }
  const parent = entries.find((e): e is GroupEntry => e.kind === 'group' && e.group.id === target.groupId)
  if (!parent) return null
  const visibleMembers = groupMemberKeys(parent.summary)
  const idx = visibleMembers.indexOf(target.infoHash)
  if (idx < 0) return null
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  const neighbor = visibleMembers[swapIdx]
  if (!neighbor) return null
  const existing = listOrder.groups[target.groupId]?.members ?? []
  return {
    kind: 'members',
    groupId: target.groupId,
    members: reorderKeys(visibleMembers, existing, target.infoHash, neighbor, direction === 'up' ? 'before' : 'after'),
  }
}
