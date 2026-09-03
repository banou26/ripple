import { useCallback, useEffect, useState } from 'react'
import { del, get, set } from 'idb-keyval'

const KEY = 'ripple:folder'

type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

/**
 * Whether this browser can grant WRITE access to a folder somebody chooses, which is a real question
 * with no platform name and the one place a window probe still belongs.
 *
 * `use-create-torrent.ts` no longer has one: `@banou/ponyfill` gives every engine the pickers, so
 * whether a PICK can be re-opened is asked of the handle it produced rather than of the window. That
 * does not carry over here, because this folder is written to. An `<input type="file">` hands over
 * copies of bytes with no route back to where they came from, so the ponyfill refuses
 * `mode: 'readwrite'` where it has no native picker, and refusing at the ask is right. What it
 * cannot do is answer the question BEFORE the ask, and a button that only reveals itself to be
 * impossible once pressed is worse than one that was never offered.
 */
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
  /**
   * True when a folder was actually chosen, false when the picker was dismissed.
   *
   * The storage warning needs the difference: it turns one press into "choose a folder AND move
   * finished downloads into it", and setting the second half after a cancelled pick would change a
   * setting the person never agreed to and surprise them later.
   */
  pick: () => Promise<boolean>
  allow: () => Promise<void>
  clear: () => Promise<void>
}

// restored handles come back without an active permission grant, so `allow` re-requests it from a user gesture
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
    if (!handle) return false
    await set(KEY, handle)
    setFolder(handle)
    setPermitted(true)
    return true
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
