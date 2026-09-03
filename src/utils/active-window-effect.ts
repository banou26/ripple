import { useCallback, useEffect, useRef, useState } from 'react'

// callers must be able to tell 'probing' apart from 'inactive': rendering the takeover prompt during the probe made an alarming "it will stop the other tab"
// message the first thing every page load painted
export type WindowClaim = 'probing' | 'active' | 'inactive'

// long enough for a live tab to answer over the BroadcastChannel, short enough that a first load is not visibly waiting on it
const PROBE_MS = 50

export const useActiveWindow = <T>({ onActive, onInactive }: { onActive?: () => T, onInactive?: (value: T) => undefined | void }) => {
  const [claim, setClaim] = useState<WindowClaim>('probing')
  const claimRef = useRef<WindowClaim>('probing')
  const [value, setValue] = useState<T>()
  const [broadcastChannel] = useState(() => new BroadcastChannel('ripple-window-instance-guard'))
  // Refs so the listener below never needs re-registering, which would reopen the probe window
  const onActiveRef = useRef(onActive)
  const onInactiveRef = useRef(onInactive)
  const valueRef = useRef<T>(undefined)
  onActiveRef.current = onActive
  onInactiveRef.current = onInactive
  valueRef.current = value

  const activate = useCallback(() => {
    broadcastChannel.postMessage('activate')
    if (onActiveRef.current) setValue(onActiveRef.current())
    claimRef.current = 'active'
    setClaim('active')
  }, [broadcastChannel])

  useEffect(() => {
    // Reported by oxlint as never reassigned, 2026-09-04, and wrong: it is assigned at the
    // `setTimeout` twenty lines below, and `const` here does not compile.
    // oxlint-disable-next-line prefer-const
    let probe: number | undefined
    const handleMessage = ({ data }: MessageEvent) => {
      if (data === 'activate') {
        window.clearTimeout(probe)
        claimRef.current = 'inactive'
        setClaim('inactive')
        const held = valueRef.current
        if (onInactiveRef.current && held !== undefined) setValue(onInactiveRef.current(held) ?? undefined)
      } else if (data === 'check') {
        if (claimRef.current !== 'active') return
        broadcastChannel.postMessage('active')
      } else if (data === 'active') {
        // Only a probing tab may lose the claim here: a reply after our own probe fired is stale, and honouring it would leave no tab owning the engine
        if (claimRef.current !== 'probing') return
        window.clearTimeout(probe)
        claimRef.current = 'inactive'
        setClaim('inactive')
      }
    }
    broadcastChannel.addEventListener('message', handleMessage)
    broadcastChannel.postMessage('check')
    probe = window.setTimeout(activate, PROBE_MS)

    return () => {
      window.clearTimeout(probe)
      broadcastChannel.removeEventListener('message', handleMessage)
    }
  }, [activate, broadcastChannel])

  useEffect(() => () => broadcastChannel.close(), [broadcastChannel])

  return {
    claim,
    isActive: claim === 'active',
    value,
    activate,
  }
}
