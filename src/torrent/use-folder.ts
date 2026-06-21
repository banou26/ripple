import { useCallback, useEffect, useState } from 'react'
import { del, get, set } from 'idb-keyval'

const KEY = 'ripple:folder'

type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

const isSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

const pickDirectory = async (): Promise<FileSystemDirectoryHandle | undefined> => {
  if (!isSupported()) return undefined
  const picker = (window as Window & { showDirectoryPicker?: (options: { id?: string, mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker!
  return picker({ id: 'ripple-downloads', mode: 'readwrite' }).catch((error: unknown) => {
    if ((error as Error)?.name === 'AbortError') return undefined
    throw error
  })
}

const queryPermission = async (handle: FileSystemDirectoryHandle): Promise<PermissionState> => {
  const { queryPermission } = handle as PermissionCapableHandle
  return await queryPermission?.call(handle, { mode: 'readwrite' }) ?? 'granted'
}

const ensurePermission = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
  if (await queryPermission(handle) === 'granted') return true
  const { requestPermission } = handle as PermissionCapableHandle
  return await requestPermission?.call(handle, { mode: 'readwrite' }) === 'granted'
}

export type UseFolder = {
  supported: boolean
  folder: FileSystemDirectoryHandle | null
  permitted: boolean
  pick: () => Promise<void>
  allow: () => Promise<void>
  clear: () => Promise<void>
}

// The persisted auto-save directory. Restored handles come back without an
// active permission grant, so `allow` re-requests it from a user gesture.
export const useFolder = (): UseFolder => {
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [permitted, setPermitted] = useState(false)

  useEffect(() => {
    (async () => {
      const stored = await get<FileSystemDirectoryHandle>(KEY)
      if (!stored) return
      setFolder(stored)
      setPermitted(await queryPermission(stored) === 'granted')
    })()
  }, [])

  const pick = useCallback(async () => {
    const handle = await pickDirectory()
    if (!handle) return
    await set(KEY, handle)
    setFolder(handle)
    setPermitted(true)
  }, [])

  const allow = useCallback(async () => {
    if (!folder) return
    setPermitted(await ensurePermission(folder))
  }, [folder])

  const clear = useCallback(async () => {
    await del(KEY)
    setFolder(null)
    setPermitted(false)
  }, [])

  return { supported: isSupported(), folder, permitted, pick, allow, clear }
}
