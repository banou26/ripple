import { useCallback, useEffect, useRef, useState } from 'react'

// Which tab owns the engine. Only one may: a libtorrent session holds exclusive OPFS
// locks on the files it is writing, so a second tab writing the same library corrupts
// both. 'probing' is the state on load while this tab asks whether anyone else already
// claimed it. It matters that callers can tell it apart from 'inactive': rendering the
// takeover prompt during the probe made an alarming "it will stop the other tab" message
// the first thing every single page load painted.
export type WindowClaim = 'probing' | 'active' | 'inactive'

// Long enough for a live tab to answer over the BroadcastChannel, short enough that a
// first load is not visibly waiting on it.
const PROBE_MS = 50

export const useActiveWindow = <T>({ onActive, onInactive }: { onActive?: () => T, onInactive?: (value: T) => undefined | void }) => {
  const [claim, setClaim] = useState<WindowClaim>('probing')
  const claimRef = useRef<WindowClaim>('probing')
  const [value, setValue] = useState<T>()
  const [broadcastChannel] = useState(() => new BroadcastChannel('ripple-window-instance-guard'))
  // Read through refs so the listener below never needs re-registering, which would
  // reopen the probe window every time a caller passes a fresh callback.
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
    let probe: number | undefined
    const handleMessage = ({ data }: MessageEvent) => {
      if (data === 'activate') {
        // Another tab took over. Give up the claim, whether or not the probe had settled.
        window.clearTimeout(probe)
        claimRef.current = 'inactive'
        setClaim('inactive')
        const held = valueRef.current
        if (onInactiveRef.current && held !== undefined) setValue(onInactiveRef.current(held) ?? undefined)
      } else if (data === 'check') {
        if (claimRef.current !== 'active') return
        broadcastChannel.postMessage('active')
      } else if (data === 'active') {
        // Someone else already owns it, so stop the probe instead of claiming it too.
        // Only a tab that is still probing may lose the claim this way: a reply that
        // arrives after our own probe fired is stale, the other tab has already been told
        // to stand down by our 'activate', and honouring it would leave no tab at all
        // owning the engine.
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
