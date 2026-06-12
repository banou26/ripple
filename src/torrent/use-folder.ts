import { useCallback, useEffect, useState } from 'react'
import { del, get, set } from 'idb-keyval'
import { fs } from '@fkn/lib'

const KEY = 'ripple:folder'

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
      setPermitted(await fs.queryDirectoryPermission(stored) === 'granted')
    })()
  }, [])

  const pick = useCallback(async () => {
    const handle = await fs.pickLocalDirectory({ id: 'ripple-downloads' })
    if (!handle) return
    await set(KEY, handle)
    setFolder(handle)
    setPermitted(true)
  }, [])

  const allow = useCallback(async () => {
    if (!folder) return
    setPermitted(await fs.ensureDirectoryPermission(folder))
  }, [folder])

  const clear = useCallback(async () => {
    await del(KEY)
    setFolder(null)
    setPermitted(false)
  }, [])

  return { supported: fs.isLocalDirectorySupported(), folder, permitted, pick, allow, clear }
}
