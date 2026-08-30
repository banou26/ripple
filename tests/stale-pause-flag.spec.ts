/*
 * A restored torrent's pause state comes from the library entry, never from the resume blob.
 *
 * libtorrent writes its own `paused` flag into resume data and `addTorrentWithResume` restores it,
 * so a torrent that was stopped when its blob was written comes back stopped. Ripple pauses
 * torrents for reasons the user never asked for (parking a cache entry nobody is watching), and
 * deliberately does not record those in the entry, so the blob and the entry disagreed and nothing
 * reconciled them. Ten seconds later, exactly the hold the restore places, `recovery` read a
 * torrent that had never failed as one that stopped on its own.
 *
 * The owner's report: refresh, wait 10s, and "A download hit a problem / Stopped unexpectedly -
 * retrying in 9s" appears with nothing in the console.
 *
 * The rig drives the engine worker directly and reloads TWICE off the same saved resume blob,
 * changing exactly one field between the two runs:
 *
 *   run 1  library entry says paused: true   -> stays stopped, and is never flagged
 *   run 2  library entry says paused: false  -> is started, and is never flagged
 *
 * MEASURED ON THE BROKEN CODE, so this is known to be able to fail: run 2 was flagged at 9,999ms
 * with reason "stopped", paused true, autoManaged false and an empty error string, while run 1 over
 * the same 22 seconds was never flagged at all. Run 1 is the control in both directions: it must
 * still honour a real pause, and it proves the rig is not simply blind.
 *
 * No network and no transfer: the bundled .torrent gives metadata locally, so this is headless.
 */
import { expect, test } from '@playwright/test'

type Row = {
  handle: number
  state: number | null
  paused: boolean | null
  autoManaged: boolean | null
  error: string
  recovery: { reason: string, attempt: number } | null
  userPaused: boolean
}
type Frame = { at: number, torrents: Row[] }

const probe = () => {
  const w = window as any
  w.__states = [] as Frame[]
  w.__engine = null
  const Original = window.Worker
  class Probe extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as any
        if (!data || typeof data !== 'object') return
        // the engine worker is the only one that speaks this protocol; libav's never does
        if (data.type === 'ready' || data.type === 'state') w.__engine = this
        if (data.type !== 'state') return
        w.__states.push({
          at: Date.now(),
          torrents: (data.torrents ?? []).map((t: any) => ({
            handle: t.handle,
            state: t.status?.state ?? null,
            paused: t.status?.paused ?? null,
            autoManaged: t.status?.autoManaged ?? null,
            error: t.status?.error ?? '',
            recovery: t.recovery ? { reason: t.recovery.reason, attempt: t.recovery.attempt } : null,
            userPaused: t.userPaused === true,
          })),
        })
      })
    }
  }
  window.Worker = Probe as unknown as typeof Worker
  // the demo would add a second torrent on its own eight seconds in, which is inside every window
  // this test measures
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
}

/** Raw idb-keyval store, so the library entry can be edited the way a previous session left it. */
const patchPaused = (paused: boolean) => new Promise<string>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve('open failed')
  request.onsuccess = () => {
    const tx = request.result.transaction('keyval', 'readwrite')
    const store = tx.objectStore('keyval')
    const read = store.get('ripple:torrents')
    read.onsuccess = () => {
      const list = read.result as any[] | undefined
      if (!list || !list.length) { resolve('no list'); return }
      for (const entry of list) entry.paused = paused
      store.put(list, 'ripple:torrents')
      tx.oncomplete = () => resolve(`patched ${list.length} to paused=${paused}`)
    }
    read.onerror = () => resolve('read failed')
  }
})

const resumeKeys = () => new Promise<string[]>((resolve) => {
  const request = indexedDB.open('keyval-store')
  request.onerror = () => resolve([])
  request.onsuccess = () => {
    const all = request.result.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys()
    all.onsuccess = () => resolve((all.result as string[]).filter((k) => String(k).startsWith('ripple:resume:')))
    all.onerror = () => resolve([])
  }
})

/** Every frame in the window, plus the first one carrying a recovery entry. */
const watchFor = async (page: import('@playwright/test').Page, ms: number) => {
  await page.waitForTimeout(ms)
  return page.evaluate(() => {
    const frames = (window as any).__states as Frame[]
    const zero = frames[0]?.at ?? 0
    const flagged = frames.find((f) => f.torrents.some((t) => t.recovery))
    return {
      frames: frames.length,
      spanMs: frames.length ? (frames[frames.length - 1]!.at - zero) : 0,
      // when the first recovery entry appeared, measured from the first state broadcast
      flaggedAtMs: flagged ? flagged.at - zero : null,
      flaggedRows: flagged ? flagged.torrents.filter((t) => t.recovery) : [],
      last: frames[frames.length - 1]?.torrents ?? [],
    }
  })
}

test('the library entry decides whether a restored torrent runs, not its resume blob', async ({ page }) => {
  test.setTimeout(300_000)
  await page.addInitScript(probe)

  await page.goto('/')
  await page.waitForFunction(() => (window as any).__engine, undefined, { timeout: 90_000 })

  // metadata comes from the bundled file, so this needs no peers and no network
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/assets/sintel.torrent')).arrayBuffer())
    ;(window as any).__engine.postMessage({ type: 'add-torrent-file', bytes })
  })

  const handle = await page
    .waitForFunction(
      () => {
        const frames = (window as any).__states as Frame[]
        const rows = frames[frames.length - 1]?.torrents ?? []
        // 2 is downloadingMetadata, which a .torrent skips; anything else means the layout is known
        const ready = rows.find((t) => t.state !== null && t.state !== 2)
        return ready ? ready.handle : null
      },
      undefined,
      { timeout: 90_000 },
    )
    .then((h) => h.jsonValue() as Promise<number>)

  // the pause Ripple itself performs, followed by the snapshot it takes right after
  await page.evaluate((h) => (window as any).__engine.postMessage({ type: 'pause', handle: h }), handle)
  await page.waitForFunction(
    () => {
      const frames = (window as any).__states as Frame[]
      return (frames[frames.length - 1]?.torrents ?? []).some((t) => t.paused === true)
    },
    undefined,
    { timeout: 30_000 },
  )
  await page.evaluate(() => (window as any).__engine.postMessage({ type: 'flush-resume' }))
  await page.waitForTimeout(4_000)

  // the whole hypothesis rests on this blob existing, so prove it does before reading anything into
  // what the reloads say
  expect(await page.evaluate(resumeKeys), 'no resume blob was written, so both reloads below would be measuring the .torrent path instead').not.toHaveLength(0)

  // The entry agrees with the blob: a pause the user asked for, which has to survive.
  expect(await page.evaluate(patchPaused, true)).toContain('patched')
  await page.reload()
  await page.waitForFunction(() => ((window as any).__states as Frame[])?.length > 0, undefined, { timeout: 90_000 })
  const kept = await watchFor(page, 22_000)
  console.log('[entry paused:true ]', JSON.stringify(kept, null, 1))

  // Same blob, same torrent, one field different: the entry says this torrent is meant to be
  // running, so the blob's flag must be overruled rather than believed.
  expect(await page.evaluate(patchPaused, false)).toContain('patched')
  await page.reload()
  await page.waitForFunction(() => ((window as any).__states as Frame[])?.length > 0, undefined, { timeout: 90_000 })
  const started = await watchFor(page, 22_000)
  console.log('[entry paused:false]', JSON.stringify(started, null, 1))

  // a pause the user chose is still a pause, and is still not a failure
  expect(kept.last[0]?.paused, 'a user pause was overruled, so Ripple now restarts torrents somebody stopped on purpose').toBe(true)
  expect(kept.last[0]?.userPaused).toBe(true)
  expect(kept.flaggedAtMs, 'a paused-on-purpose torrent was reported as having stopped').toBeNull()

  // and the blob's flag does not outlive the entry that disagrees with it
  expect(started.last[0]?.paused, 'the resume blob kept this torrent stopped even though the library says it is running').toBe(false)
  expect(started.last[0]?.userPaused).toBe(false)
  expect(started.flaggedAtMs, 'flagged as stopped: this is the 10s banner the fix is for').toBeNull()
})
