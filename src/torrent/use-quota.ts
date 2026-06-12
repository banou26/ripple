import { useEffect, useState } from 'react'

import { cloud } from '@fkn/lib'

export type QuotaStatus = Awaited<ReturnType<typeof cloud.quota>>

// Polls the FKN cloud-egress quota while `active` (a transfer is running). The broker caches the
// result for 5s so a 15s interval is effectively free; stays null until the first read resolves.
export const useQuota = (active: boolean): QuotaStatus | null => {
  const [quota, setQuota] = useState<QuotaStatus | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const poll = () =>
      cloud.quota()
        .then((q) => { if (!cancelled) setQuota(q) })
        .catch(() => {})
    poll()
    const id = window.setInterval(poll, 15_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [active])
  return quota
}
