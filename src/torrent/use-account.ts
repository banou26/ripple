import { useCallback, useEffect, useState } from 'react'

import { account } from '@fkn/lib'

export type AccountInfo = Awaited<ReturnType<typeof account.info>>

// info() awaits the broker iframe, which has no built-in timeout; resolve to null if it stalls so the
// widget can fall back to a Connect affordance instead of hanging hidden.
const readAccount = (): Promise<AccountInfo> =>
  Promise.race([
    account.info(),
    new Promise<AccountInfo>((resolve) => setTimeout(() => resolve(null), 4_000)),
  ])

// Tracks the FKN account connected to this page (who is signed in, premium, and the login/logout actions).
export const useAccount = () => {
  const [info, setInfo] = useState<AccountInfo>(null)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    const next = await readAccount().catch(() => null)
    setInfo(next)
    setReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = () =>
      readAccount()
        .then((next) => { if (!cancelled) { setInfo(next); setReady(true) } })
        .catch(() => { if (!cancelled) setReady(true) })
    poll()
    const id = window.setInterval(poll, 15_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const login = useCallback(async () => {
    await account.login().catch(() => {})
    await refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await account.logout().catch(() => {})
    await refresh()
  }, [refresh])

  return { info, ready, login, logout }
}
