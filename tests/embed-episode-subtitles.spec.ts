// Remote episode previous/next controls, source switch, subtitle browsing, and external subtitle tracks
// over @banou/media-player/remote on Ripple's /watch embed route.
import type { Frame, FrameLocator, Page } from '@playwright/test'

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from './offline'
import { linkParams } from '../src/router/path'

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
const SRC = `/watch?${new URLSearchParams({ magnet: Buffer.from(MAGNET).toString('base64') })}`
const HARNESS = 'test-results/remote-harness/remote-harness.js'
const TENANT_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'"
const NAME = 'External.Subtitles.Episode.mkv'

type RemotePlayer = ReturnType<Window['mediaPlayer']>
type EmbedderWindow = Window & {
  player: RemotePlayer
  requests: string[]
  requested: string[]
  picked: unknown[]
}
type Root = Page | FrameLocator

const CONTAINER_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Liberation Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,HHHHHHHH',
  '',
].join('\n')

const EXTERNAL_SRT = [
  '1',
  '00:00:00,000 --> 00:00:30,000',
  '<font color="#ff0000">HHHHHHHH</font>',
  '',
].join('\n')

const EXTERNAL_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Liberation Sans,72,&H00FF0000,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,HHHHHHHH',
  '',
].join('\n')

const makeEpisode = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'line.ass'), CONTAINER_ASS)
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x101010:size=640x360:rate=24:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-i', 'line.ass',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-c:s', 'copy',
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-metadata:s:s:0', 'language=eng',
    NAME,
  ], { cwd: dir, encoding: 'utf8' })
  if (run.error || run.status !== 0) {
    throw new Error(`ffmpeg failed, and this spec needs it on PATH: ${run.error?.message ?? run.stderr}`)
  }
  return join(dir, NAME)
}

const instrument = () => {
  const w = window as unknown as Window & {
    __violations: string[]
    showDirectoryPicker?: unknown
    showOpenFilePicker?: unknown
  }
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  delete w.showDirectoryPicker
  delete w.showOpenFilePicker
  w.__violations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    w.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`)
  })
}

const colourOf = (frame: Frame) => frame.evaluate(() => {
  const surface = document.querySelector<HTMLCanvasElement>('.subtitles canvas')
  if (!surface?.width || !surface.height) return null
  const copy = document.createElement('canvas')
  copy.width = surface.width
  copy.height = surface.height
  const context = copy.getContext('2d')!
  context.drawImage(surface, 0, 0)
  const { data } = context.getImageData(0, 0, copy.width, copy.height)
  const counts = { red: 0, green: 0, blue: 0, white: 0 }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! <= 16) continue
    const [r, g, b] = [data[index]!, data[index + 1]!, data[index + 2]!]
    if (r > 200 && g > 200 && b > 200) counts.white++
    else if (r > 200 && g < 60 && b < 60) counts.red++
    else if (g > 200 && r < 60 && b < 60) counts.green++
    else if (b > 200 && r < 60 && g < 60) counts.blue++
  }
  const [name, count] = Object.entries(counts).sort(([, a], [, b]) => b - a)[0]!
  return count > 50 ? name : null
})

const trackMenu = (root: Root) => root.locator('.popover.track-list')
const trackRows = (root: Root) => trackMenu(root).locator(':scope > div.description')
const trackRow = (root: Root, label: string) => trackRows(root).filter({ has: root.locator('span.track-label').filter({ hasText: new RegExp(`^${label}$`) }) })

let hoverOffset = 0
const openSubtitles = async (page: Page, ripple: FrameLocator) => {
  const box = await page.locator('#ripple').boundingBox()
  if (box) {
    hoverOffset = (hoverOffset + 13) % 40
    await page.mouse.move(box.x + box.width / 2 + hoverOffset, box.y + box.height / 2)
  }
  await expect(ripple.locator('.control-bar')).toHaveCSS('opacity', '1')
  if (!await trackMenu(ripple).isVisible()) {
    await ripple.locator('button.subtitles').click()
  }
  await expect(trackMenu(ripple)).toBeVisible()
}

const loadHarness = async (page: Page) => {
  await page.route('**/remote-harness.js', (route) =>
    route.fulfill({ body: readFileSync(HARNESS, 'utf8'), contentType: 'text/javascript' }),
  )
  await page.addScriptTag({ url: '/remote-harness.js', type: 'module' })
  await page.waitForFunction(() => typeof window.mediaPlayer === 'function', null, { timeout: 10_000 })
}

test.beforeAll(() => {
  execFileSync('node', ['scripts/bundle-remote-harness.mjs'], { stdio: 'inherit' })
})

test('an embedder sets previousEpisode and nextEpisode and receives step requests beside Play/Pause', async ({ page }) => {
  await page.goto('/legal')
  await loadHarness(page)
  await page.evaluate(async (src) => {
    const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
    const w = window as unknown as EmbedderWindow
    w.requests = []
    w.player = window.mediaPlayer(frame, { origin: location.origin })
    w.player.addEventListener('previousrequest', () => w.requests.push('previous'))
    w.player.addEventListener('nextrequest', () => w.requests.push('next'))
    await w.player.ready
  }, SRC)

  const ripple = page.frameLocator('#ripple')
  await expect(ripple.locator('button.play')).toBeVisible()
  await expect(ripple.locator('button.previous')).toHaveCount(0)
  await expect(ripple.locator('button.next')).toHaveCount(0)

  await page.evaluate(() => {
    const { player } = window as unknown as EmbedderWindow
    player.previousEpisode = 'Episode 1'
    player.nextEpisode = 'Episode 3'
  })

  await expect(ripple.locator('button.previous')).toBeVisible()
  await expect(ripple.locator('button.previous')).toHaveAttribute('aria-label', 'Episode 1')
  await expect(ripple.locator('button.previous svg')).toBeVisible()
  await expect(ripple.locator('button.next')).toBeVisible()
  await expect(ripple.locator('button.next')).toHaveAttribute('aria-label', 'Episode 3')
  await expect(ripple.locator('button.next svg')).toBeVisible()

  const watchFrame = page.frames().find((f) => f.url().includes('/watch'))!
  const layout = await watchFrame.evaluate(() => {
    const left = document.querySelector('.actions > .left')
    if (!left) return null
    const classes = [...left.children].map((child) => {
      const btn = child.querySelector('button')
      return btn ? btn.className : child.className
    })
    const play = left.querySelector('button.play')?.getBoundingClientRect()
    const previous = left.querySelector('button.previous')?.getBoundingClientRect()
    const next = left.querySelector('button.next')?.getBoundingClientRect()
    return { classes, play, previous, next }
  })
  expect(layout).not.toBeNull()
  expect(layout!.classes).toEqual(['play', 'previous', 'next', 'sound', 'time'])
  expect(layout!.previous!.left).toBeGreaterThanOrEqual(layout!.play!.right - 1)
  expect(layout!.next!.left).toBeGreaterThanOrEqual(layout!.previous!.right - 1)

  await ripple.locator('button.previous').click()
  await ripple.locator('button.next').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requests)).toEqual(['previous', 'next'])

  await page.evaluate(() => {
    const { player } = window as unknown as EmbedderWindow
    player.previousEpisode = false
    player.nextEpisode = true
  })
  await expect(ripple.locator('button.previous')).toHaveCount(0)
  await expect(ripple.locator('button.next')).toHaveAttribute('aria-label', 'Next episode')

  await page.evaluate(
    (magnet) => (document.getElementById('ripple') as HTMLIFrameElement).contentWindow!.postMessage({ ripple: 'open', magnet, fileIndex: 1 }, '*'),
    MAGNET,
  )
  await expect.poll(() => linkParams(new URL(page.frames().find((f) => f.url().includes('/watch'))!.url())).get('fileIndex')).toBe('1')
  await expect(ripple.locator('button.previous')).toHaveCount(0)
  await expect(ripple.locator('button.next')).toBeVisible()
  await expect(ripple.locator('button.next')).toHaveAttribute('aria-label', 'Next episode')
  await ripple.locator('button.next').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requests)).toEqual(['previous', 'next', 'next'])
})

test('an embedder sets sourceSwitch and browseSubtitles and receives requests over @banou/media-player/remote', async ({ page }) => {
  await page.goto('/legal')
  await loadHarness(page)
  await page.evaluate(async (src) => {
    const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
    document.body.append(frame)
    const w = window as unknown as EmbedderWindow
    w.requests = []
    w.player = window.mediaPlayer(frame, { origin: location.origin })
    w.player.addEventListener('sourceswitchrequest', () => w.requests.push('sourceSwitch'))
    w.player.addEventListener('subtitlesbrowserequest', () => w.requests.push('browseSubtitles'))
    await w.player.ready
  }, SRC)

  const ripple = page.frameLocator('#ripple')
  await expect(ripple.locator('button.play')).toBeVisible()
  await expect(ripple.locator('button.source-switch')).toHaveCount(0)
  await expect(ripple.locator('button.subtitles')).toHaveCount(0)

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.sourceSwitch = 'Switch release'
  })
  await expect(ripple.locator('button.source-switch')).toBeVisible()
  await expect(ripple.locator('button.source-switch')).toHaveAttribute('aria-label', 'Switch release')
  await expect(ripple.locator('button.source-switch svg')).toBeVisible()
  await ripple.locator('button.source-switch').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requests)).toEqual(['sourceSwitch'])

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.sourceSwitch = true
  })
  await expect(ripple.locator('button.source-switch')).toHaveAttribute('aria-label', 'Switch source')

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.sourceSwitch = false
  })
  await expect(ripple.locator('button.source-switch')).toHaveCount(0)

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.browseSubtitles = true
  })
  await expect(ripple.locator('button.subtitles')).toBeVisible()
  await openSubtitles(page, ripple)
  const browseBtn = trackMenu(ripple).locator('.track-footer-action.browse-subtitles')
  await expect(browseBtn).toBeVisible()
  await expect(browseBtn).toHaveText('Look for more')
  await browseBtn.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requests)).toEqual(['sourceSwitch', 'browseSubtitles'])
  await expect(trackMenu(ripple)).toHaveCount(0)

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.browseSubtitles = 'Search subtitles'
  })
  await openSubtitles(page, ripple)
  await expect(browseBtn).toHaveText('Search subtitles')
  await ripple.locator('button.subtitles').click()
  await expect(trackMenu(ripple)).toHaveCount(0)

  await page.evaluate(() => {
    (window as unknown as EmbedderWindow).player.browseSubtitles = false
  })
  await expect(ripple.locator('button.subtitles')).toHaveCount(0)
})

test('/watch opened directly renders no previous, next, or source-switch buttons', async ({ page }) => {
  await page.goto(SRC)
  await expect(page.locator('button.play')).toBeVisible()
  await expect(page.locator('button.previous')).toHaveCount(0)
  await expect(page.locator('button.next')).toHaveCount(0)
  await expect(page.locator('button.source-switch')).toHaveCount(0)
})

test('an embedder pushes external SRT and ASS subtitles, serves subtitleloadrequest, and keeps container tracks working', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const file = makeEpisode(test.info().outputPath())
  const rippleOrigin = new URL(baseURL!).origin

  const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' })
  try {
    const page = await context.newPage()
    await page.addInitScript(instrument)
    const logs: string[] = []
    page.on('pageerror', (error) => logs.push(`pageerror:${String(error)}`))
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') logs.push(`${msg.type()}:${msg.text()}`)
    })
    await context.route(
      (url) => url.origin === rippleOrigin && (url.pathname === '/watch' || url.pathname.startsWith('/jassub/')),
      async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': TENANT_CSP } })
      },
    )

    await page.goto('/')
    await page.getByRole('button', { name: 'Create a torrent' }).click()
    const dialog = page.getByRole('dialog')
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
    await (await chooser).setFiles(file)
    await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
    await expect(dialog.locator('[data-outcome="copied"]')).toBeVisible({ timeout: 120_000 })
    await dialog.getByRole('button', { name: 'Close' }).click()
    const link = page.getByRole('link', { name: `Watch ${NAME}` })
    await expect(link).toBeVisible({ timeout: 120_000 })
    const watchHref = new URL((await link.getAttribute('href'))!, page.url()).href

    await page.goto('/legal')
    await loadHarness(page)
    await page.evaluate(async ({ src, srt, ass }) => {
      const frame = Object.assign(document.createElement('iframe'), { id: 'ripple', src, allow: 'autoplay' })
      Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', border: 'none' })
      document.body.append(frame)
      const w = window as unknown as EmbedderWindow
      w.requested = []
      w.picked = []
      window.addEventListener('message', (event) => {
        if (event.source === frame.contentWindow && event.data && typeof event.data === 'object' && event.data.ripple === 'picked') {
          w.picked.push(event.data)
        }
      })
      w.player = window.mediaPlayer(frame, { origin: location.origin })
      w.player.addEventListener('subtitleloadrequest', (ev) => {
        const { trackId } = (ev as CustomEvent<{ trackId: string }>).detail
        w.requested.push(trackId)
        if (trackId === 'ext-srt') w.player.provideExternalSubtitle(trackId, srt)
        else if (trackId === 'ext-ass') w.player.provideExternalSubtitle(trackId, ass)
        else w.player.provideExternalSubtitle(trackId, null, 'Forbidden')
      })
      await w.player.ready
    }, { src: watchHref, srt: EXTERNAL_SRT, ass: EXTERNAL_ASS })

    await expect.poll(() => page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/watch'))).toBeTruthy()
    const watchFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/watch'))!

    const blobRefused = await watchFrame.evaluate(() => new Promise<boolean>((resolve) => {
      try {
        const probe = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
        probe.onmessage = () => resolve(false)
        probe.onerror = () => resolve(true)
      } catch {
        resolve(true)
      }
    }))
    expect(blobRefused, 'the tenant CSP is not in force on /watch').toBe(true)

    try {
      await expect.poll(() => colourOf(watchFrame), { timeout: 60_000, intervals: [250] }).toBe('white')
    } catch (error) {
      const state = await watchFrame.evaluate(() => {
        const v = document.querySelector('video')
        const c = document.querySelector<HTMLCanvasElement>('.subtitles canvas')
        return {
          video: v ? { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, err: v.error?.code ?? null } : null,
          canvas: c ? { w: c.width, h: c.height, pending: c.dataset.pending ?? null } : null,
        }
      }).catch((evalError) => String(evalError))
      throw new Error(`${error instanceof Error ? error.message : String(error)}\ndiag=${JSON.stringify({ state, logs })}`, { cause: error })
    }
    await page.evaluate(() => (window as unknown as EmbedderWindow).player.pause())
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).player.paused)).toBe(true)

    await page.evaluate(() => {
      (window as unknown as EmbedderWindow).player.setExternalSubtitles([
        { id: 'ext-srt', language: 'fr', label: 'External French SRT', format: 'srt' },
        { id: 'ext-ass', language: 'ja', label: 'External Japanese ASS', format: 'ass' },
        { id: 'ext-fail', language: 'de', label: 'Broken External', format: 'vtt' },
      ])
    })

    const ripple = page.frameLocator('#ripple')
    await openSubtitles(page, ripple)
    await expect(trackRow(ripple, 'External French SRT')).toBeVisible()
    await expect(trackRow(ripple, 'External French SRT').locator('.track-kind--external')).toHaveText('External')
    await expect(trackRow(ripple, 'External Japanese ASS')).toBeVisible()
    await expect(trackRow(ripple, 'External Japanese ASS').locator('.track-kind--external')).toHaveText('External')
    await expect(trackRow(ripple, 'Broken External')).toBeVisible()
    await expect(trackRow(ripple, 'Broken External').locator('.track-kind--external')).toHaveText('External')
    await expect(trackRow(ripple, 'English')).toBeVisible()
    await expect(trackRow(ripple, 'English').locator('.track-kind--native')).toHaveText('Native')

    await trackRow(ripple, 'Broken External').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requested)).toEqual(['ext-fail'])
    await expect(trackMenu(ripple).locator('.failed')).toBeVisible()

    await trackRow(ripple, 'External French SRT').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requested)).toEqual(['ext-fail', 'ext-srt'])
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('red')
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).picked)).toContainEqual({ ripple: 'picked', subtitles: 'fr' })

    await openSubtitles(page, ripple)
    await expect(trackRow(ripple, 'External French SRT')).toContainText('✓')
    await trackRow(ripple, 'External Japanese ASS').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requested)).toEqual(['ext-fail', 'ext-srt', 'ext-ass'])
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('blue')
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).picked)).toContainEqual({ ripple: 'picked', subtitles: 'ja' })

    await openSubtitles(page, ripple)
    await trackRow(ripple, 'English').click()
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('white')
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).picked)).toContainEqual({ ripple: 'picked', subtitles: 'eng' })

    await page.evaluate(() => {
      const w = window as unknown as EmbedderWindow
      w.picked = []
      w.player.selectExternalSubtitle('ext-ass')
    })
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('blue')
    await openSubtitles(page, ripple)
    await expect(trackRow(ripple, 'External Japanese ASS')).toContainText('✓')
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).picked)).toEqual([{ ripple: 'picked', subtitles: 'ja' }])
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).requested)).toEqual(['ext-fail', 'ext-srt', 'ext-ass'])
    await trackRow(ripple, 'English').click()
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('white')

    await page.evaluate(() => {
      (window as unknown as EmbedderWindow).player.setExternalSubtitles([])
    })
    await openSubtitles(page, ripple)
    await expect(trackRow(ripple, 'External French SRT')).toHaveCount(0)
    await expect(trackRow(ripple, 'External Japanese ASS')).toHaveCount(0)
    await expect(trackRow(ripple, 'Broken External')).toHaveCount(0)
    await expect(trackRow(ripple, 'English')).toBeVisible()
    await expect(trackRow(ripple, 'English')).toContainText('✓')
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('white')

    // Subtitle settings: Simple mode, offset, text size, background opacity, and pointer drag + reset
    await ripple.locator('.subtitle-options-btn').click()
    const settingsMenu = ripple.locator('.popover.subtitle-settings')
    await expect(settingsMenu).toBeVisible()
    await settingsMenu.getByRole('switch').click()
    await expect(settingsMenu.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await expect(ripple.locator('.subtitles canvas')).toHaveCSS('display', 'none')
    await expect(ripple.locator('.subtitle-cue-line')).toContainText('HHHHHHHH')

    await settingsMenu.getByRole('button', { name: 'Text size +' }).click()
    await settingsMenu.locator('.bg-row button.sub-pill', { hasText: '50%' }).click()
    const cueBox = ripple.locator('.subtitle-cues-box')
    await expect(cueBox).toHaveCSS('--mp-sub-scale', '1.1')
    await expect(cueBox).toHaveCSS('--mp-sub-bg-opacity', '0.5')

    const beforeDrag = await cueBox.boundingBox()
    expect(beforeDrag).not.toBeNull()
    await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2, beforeDrag!.y + beforeDrag!.height / 2)
    await page.mouse.down()
    await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2, beforeDrag!.y - 80, { steps: 6 })
    await page.mouse.up()
    const afterDrag = await cueBox.boundingBox()
    expect(afterDrag!.y).toBeLessThan(beforeDrag!.y - 30)
    await expect.poll(() => page.evaluate(() => (window as unknown as EmbedderWindow).player.paused)).toBe(true)

    const resetPosBtn = settingsMenu.getByRole('button', { name: 'Reset position' })
    await expect(resetPosBtn).toBeVisible()
    await resetPosBtn.click()
    await expect(resetPosBtn).toHaveCount(0)
    await expect.poll(async () => (await cueBox.boundingBox())!.y).toBeGreaterThan(afterDrag!.y + 30)

    await settingsMenu.locator('.step-row button.sub-pill', { hasText: '+0.5s' }).click()
    await expect(settingsMenu.locator('.offset-readout')).toHaveText('+0.5s')
    await settingsMenu.locator('.sub-reset-btn').click()
    await expect(settingsMenu.locator('.offset-readout')).toHaveText('0.0s')

    await settingsMenu.getByRole('switch').click()
    await expect(settingsMenu.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('white')
    await settingsMenu.locator('.back').click()
    await expect(trackMenu(ripple)).toBeVisible()
    await ripple.locator('button.subtitles').click()
    await expect(trackMenu(ripple)).toHaveCount(0)

    // Drag and drop a .srt file onto /watch player: auto-selects External track
    const droppedSrt = [
      '1',
      '00:00:00,000 --> 00:00:30,000',
      '<font color="#00ff00">HHHHHHHH</font>',
      '',
    ].join('\n')
    const dropTransfer = await watchFrame.evaluateHandle((text) => {
      const dt = new DataTransfer()
      dt.items.add(new File([text], 'Dropped.French.fr.srt', { type: 'application/x-subrip' }))
      return dt
    }, droppedSrt)
    await ripple.locator('.video').dispatchEvent('dragenter', { dataTransfer: dropTransfer })
    await expect(ripple.locator('.subtitle-drop-hint')).toBeVisible()
    await ripple.locator('.video').dispatchEvent('drop', { dataTransfer: dropTransfer })
    await expect(ripple.locator('.subtitle-drop-hint')).toHaveCount(0)
    await expect.poll(() => colourOf(watchFrame), { timeout: 20_000, intervals: [250] }).toBe('green')
    await openSubtitles(page, ripple)
    await expect(trackRow(ripple, 'Dropped.French.fr')).toBeVisible()
    await expect(trackRow(ripple, 'Dropped.French.fr').locator('.track-kind--external')).toHaveText('External')
    await expect(trackRow(ripple, 'Dropped.French.fr')).toContainText('✓')

    const violations = await watchFrame.evaluate(() => (window as unknown as { __violations: string[] }).__violations)
    expect(violations.filter((violation) => !violation.endsWith(' blob')), 'only the probe is refused').toEqual([])
  } finally {
    await context.close()
  }
})
