import { useEffect, useState } from 'react'

/** Whether the service worker controls this page, which is what lets a save start with no click. */
export const useControlled = (): boolean => {
  const workers = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  const [controlled, setControlled] = useState(() => Boolean(workers?.controller))
  useEffect(() => {
    if (!workers) return
    const update = () => setControlled(Boolean(workers.controller))
    workers.addEventListener('controllerchange', update)
    // a controller that came after the first render sent its controllerchange before anything listened
    update()
    return () => workers.removeEventListener('controllerchange', update)
  }, [workers])
  return controlled
}
