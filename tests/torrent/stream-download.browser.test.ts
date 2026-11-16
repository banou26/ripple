import { afterAll, expect, it } from 'vitest'

import { openStreamSink } from '../../src/torrent/stream-download'

/*
 * The real worker (src/sw.js, which the dev server serves) and the real save frame, in Chromium, Firefox and WebKit
 * (see vite.config.ts). WebKit sent ripple's frame, sandboxed without scripts, to the server instead of the worker,
 * so no first pull ever came: the save fell back to memory, which refuses a file over 1 GiB.
 */
let registration: ServiceWorkerRegistration | undefined
afterAll(() => registration?.unregister())

it('hands a save to the service worker', async () => {
  registration = await navigator.serviceWorker.register('/sw.js')
  await expect.poll(() => navigator.serviceWorker.controller, { timeout: 10_000 }).not.toBeNull()

  const sink = await openStreamSink('probe.bin', 4)
  expect(sink, 'the frame never reached the worker').not.toBeNull()
  await sink!.write(new Uint8Array([1, 2, 3, 4]))
  await sink!.close()
}, 30_000)
