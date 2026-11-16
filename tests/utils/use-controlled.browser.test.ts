import { afterEach, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useControlled } from '../../src/utils/use-controlled'

let controller: object | null = null
afterEach(() => {
  delete (navigator.serviceWorker as { controller?: unknown }).controller
  controller = null
})

// a worker that takes control between the first render and the subscription sends its controllerchange to nobody
it('sees a controller that came before it listened', async () => {
  Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => controller })
  const seen: boolean[] = []
  const { result } = await renderHook(() => {
    const controlled = useControlled()
    seen.push(controlled)
    controller ??= {}
    return controlled
  })
  expect(seen[0], 'the first render saw the controller, so this proves nothing').toBe(false)
  await expect.poll(() => result.current).toBe(true)
})
