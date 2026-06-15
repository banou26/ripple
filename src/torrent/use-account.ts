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

// Tracks the FKN account connected to this page. The Connect button is rendered by the fkn.app broker (a
// single click then opens the sign-in popup), so here we only opt in while mounted and refresh on change.
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
    // opt into the broker-rendered Connect button only after the first read, so the header has reserved its
    // slot by then and the fixed button never overlaps the form during the initial load
    refresh().then(() => { if (!cancelled) account.showConnectButton() })
    const id = window.setInterval(() => { if (!cancelled) refresh() }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
      unsubscribe.then((off) => off()).catch(() => {})
      account.hideConnectButton()
    }
  }, [refresh])

  const logout = useCallback(async () => {
    await account.logout().catch(() => {})
    await refresh()
  }, [refresh])

  return { info, ready, logout }
}
