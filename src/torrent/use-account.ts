import { useCallback, useEffect, useState } from 'react'

import { account } from '@fkn/lib'

export type AccountInfo = Awaited<ReturnType<typeof account.info>>

// info() awaits the broker iframe, which has no built-in timeout; resolve to null if it stalls so the UI
// settles instead of hanging on the first read.
const readAccount = (): Promise<AccountInfo> =>
  Promise.race([
    account.info(),
    new Promise<AccountInfo>((resolve) => setTimeout(() => resolve(null), 4_000)),
  ])

// Tracks the FKN account connected to this page. The Connect button is an embeddable fkn.app iframe the
// header renders directly (see connectButtonUrl); here we just read the state and refresh on change.
export const useAccount = () => {
  const [info, setInfo] = useState<AccountInfo>(null)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(
    () => readAccount().then((next) => { setInfo(next); setReady(true) }).catch(() => setReady(true)),
    [],
  )

  useEffect(() => {
    let cancelled = false
    const unsubscribe = account.onChange(() => { if (!cancelled) refresh() })
    refresh()
    const id = window.setInterval(() => { if (!cancelled) refresh() }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
      unsubscribe.then((off) => off()).catch(() => {})
    }
  }, [refresh])

  const logout = useCallback(async () => {
    await account.logout().catch(() => {})
    await refresh()
  }, [refresh])

  return { info, ready, logout }
}
