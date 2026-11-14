import { useEffect, useState } from 'react'

import { cloud } from '@fkn/lib'

import { useEngineTransport } from './use-reachability'

export type QuotaStatus = Awaited<ReturnType<typeof cloud.quota>>

/**
 * What is left of the FKN quota, which is what the relay meters. Null with the VPN off: nothing passes through
 * the relay then, so no transfer is counted and there is no figure to show beside one.
 */
// the broker caches the result for 5s so a 15s interval is effectively free
export const useQuota = (active: boolean): QuotaStatus | null => {
  const [quota, setQuota] = useState<QuotaStatus | null>(null)
  const metered = useEngineTransport() !== 'direct'
  useEffect(() => {
    if (!metered) setQuota(null)
    if (!active || !metered) return
    let cancelled = false
    const poll = () =>
      cloud.quota()
        .then((q) => { if (!cancelled) setQuota(q) })
        .catch(() => {})
    poll()
    const id = window.setInterval(poll, 15_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [active, metered])
  return quota
}
