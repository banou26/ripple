// The metadata a device learns has to be ANNOUNCED, not merely written to disk.
//
// A torrent's name, size and file list are what a second device signed into the same account shows
// instead of eight hex characters and a size of zero. They are learned by the device that has the
// torrent, the moment its layout is known, and they reach the account only through the library list
// the page broadcasts: use-cloud-backup schedules its write off that broadcast and nothing else.
//
// So a patch that writes them quietly is invisible for the whole session. The bytes are on disk and
// every local render is right, which is exactly why this is worth a test: the device that already
// knew the answer looks perfect, and the only thing that changes is the phone in someone's pocket,
// which nobody has open while they work.
//
// Headless on purpose. Nothing here waits on a swarm: the app seeds itself from the bundled
// sintel.torrent, and a .torrent carries its own layout, so the metadata is known at boot.

import { expect, test } from '@playwright/test'

type ListEntry = { infoHash?: string, name?: string, size?: number, files?: { name: string, size: number }[] }

test('a torrent whose metadata just landed is announced to the page, not only stored', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Every `list` the engine posts, in order. The engine is the only worker that sends this type, so
  // wrapping the constructor rather than picking a worker by URL keeps this independent of bundling.
  await page.addInitScript(() => {
    ;(window as any).__lists = []
    const OriginalWorker = window.Worker
    class Probe extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', (event: MessageEvent) => {
          const m = event.data as { type?: string, list?: unknown } | null
          if (m?.type === 'list' && Array.isArray(m.list)) (window as any).__lists.push(m.list)
        })
      }
    }
    window.Worker = Probe
  })

  await page.goto('/')
  await expect(page.locator('.torrent').first().locator('.title strong')).toHaveText('Sintel')

  const withMetadata = async () => await page.evaluate(() => {
    const lists = (window as any).__lists as ListEntry[][]
    return lists.some((list) => list.some((e) => !!e.name && !!e.size && !!e.files?.length))
  })

  await expect.poll(withMetadata, {
    message: 'no broadcast list ever carried name, size and files',
    timeout: 30_000,
  }).toBe(true)

  // The control, and the reason a failure above means something. If the probe were not capturing,
  // "no list carried metadata" would be true for a reason that has nothing to do with the engine.
  const captured = await page.evaluate(() => ((window as any).__lists as unknown[][]).length)
  expect(captured, 'the probe captured no list at all, so it cannot prove anything about their contents').toBeGreaterThan(0)

  // and the announced metadata is the torrent's own, not a placeholder
  const announced = await page.evaluate(() => {
    const lists = (window as any).__lists as ListEntry[][]
    for (const list of lists) {
      const hit = list.find((e) => !!e.name && !!e.files?.length)
      if (hit) return { name: hit.name, size: hit.size, fileCount: hit.files!.length }
    }
    return null
  })
  expect(announced).not.toBeNull()
  expect(announced!.name).toContain('Sintel')
  expect(announced!.size).toBeGreaterThan(0)
  expect(announced!.fileCount).toBeGreaterThan(0)

  expect(pageErrors).toEqual([])
})
