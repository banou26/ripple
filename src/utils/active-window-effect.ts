import { useCallback, useEffect, useRef, useState } from 'react'

export const useActiveWindow = <T>({ onActive, onInactive }: { onActive?: () => T, onInactive?: (value: T) => undefined | void }) => {
  const [isActive, setIsActive] = useState(false)
  const isActiveRef = useRef(false)
  const [value, setValue] = useState<T>()
  const [broadcastChannel] = useState(new BroadcastChannel('ripple-window-instance-guard'))

  const activate = useCallback(() => {
    broadcastChannel.postMessage('activate')
    if (onActive) setValue(onActive())
    isActiveRef.current = true
    setIsActive(true)
  }, [])

  useEffect(() => {
    let _resolveActive
    const promise = new Promise<void>(resolve => {
      _resolveActive = resolve
    })
    const handleMessage = ({ data }: MessageEvent) => {
      if (data === 'activate') {
        isActiveRef.current = false
        setIsActive(false)
        if (onInactive && value) setValue(onInactive(value) ?? undefined)
      } else if (data === 'check') {
        if (!isActiveRef.current) return
        broadcastChannel.postMessage('active')
      } else if (data === 'active') {
        _resolveActive()
      }
    }
    broadcastChannel.addEventListener('message', handleMessage)

    broadcastChannel.postMessage('check')
    
    const interval = setTimeout(activate, 50)
    promise.then(() => clearTimeout(interval))

    return () => {
      broadcastChannel.removeEventListener('message', handleMessage)
    }
  }, [])

  return {
    isActive,
    value,
    activate
  }
}
