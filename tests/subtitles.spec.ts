/*
 * ASS subtitles through ripple's own build: a file with an ASS track made into a torrent on this device, played on
 * /watch, and the line read off the surface jassub drew. jassub's worker imports the script that runs its wasm by url,
 * one of the files the build writes to `build/jassub/`, so a missing, renamed or refused one ends here as a picture
 * with no subtitles on it and no error anywhere.
 *
 * Twice: on ripple's own site, and in a frame of another site under the fkn.app tenant's CSP (fkn-client
 * `sandbox/src/shared/tenant.ts`), the strictest host ripple runs on: a script from a `blob:` or `data:` is refused
 * there, and a same-origin worker takes its policy from its own response. libav's worker is left without it, as in
 * volume-normalizer.spec.ts.
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import type { Frame, FrameLocator, Page } from '@playwright/test'

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from './offline'

const TENANT_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'"

const NAME = 'Subtitled.Episode.mkv'

const HEADER = [
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

const makeEpisode = (dir: string) => {
  writeFileSync(join(dir, 'line.ass'), HEADER)
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x101010:size=640x360:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-i', 'line.ass',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-c:s', 'copy',
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-metadata:s:s:0', 'language=eng',
    NAME,
  ], { cwd: dir, encoding: 'utf8' })
  if (run.error || run.status !== 0) throw new Error(`ffmpeg failed, and this spec needs it on PATH: ${run.error?.message ?? run.stderr}`)
  return join(dir, NAME)
}

const instrument = () => {
  const w = window as any
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  delete w.showDirectoryPicker
  delete w.showOpenFilePicker
  w.__violations = [] as string[]
  document.addEventListener('securitypolicyviolation', (event) => w.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`))
}

/** The bounding box of what jassub painted, copied out of its canvas, which belongs to its worker. */
const inked = (frame: Frame) => frame.evaluate(() => {
  const surface = document.querySelector<HTMLCanvasElement>('.subtitles canvas')
  if (!surface?.width || !surface.height) return null
  const copy = document.createElement('canvas')
  copy.width = surface.width
  copy.height = surface.height
  const context = copy.getContext('2d')!
  context.drawImage(surface, 0, 0)
  const { data } = context.getImageData(0, 0, copy.width, copy.height)
  let x1 = copy.width, y1 = copy.height, x2 = -1, y2 = -1
  for (let y = 0; y < copy.height; y++) {
    for (let x = 0; x < copy.width; x++) {
      if (data[(y * copy.width + x) * 4 + 3]! <= 16) continue
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y)
    }
  }
  return x2 < 0 ? null : { width: copy.width, height: copy.height, x1, y1, x2, y2 }
})

/** Makes the torrent in `frame`, the way a person does, and loads its /watch there. */
const watch = async (page: Page, scope: Page | FrameLocator, frame: Frame, file: string) => {
  await scope.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = scope.getByRole('dialog')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
  await (await chooser).setFiles(file)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.locator('[data-outcome="copied"]')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()
  const link = scope.getByRole('link', { name: `Watch ${NAME}` })
  await expect(link).toBeVisible({ timeout: 120_000 })
  // a document load rather than the in-app navigation a click makes, so /watch is served with its own headers
  await frame.goto(new URL((await link.getAttribute('href'))!, frame.url()).href)
}

const TOPOLOGIES = [
  { where: 'on its own site', framed: false },
  { where: 'framed by another site, under the tenant CSP', framed: true },
] as const

for (const { where, framed } of TOPOLOGIES) {
  test(`an ASS line is drawn ${where}`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const file = makeEpisode(test.info().outputPath())
    const ripple = new URL(baseURL!).origin

    // no service worker, so the CSP below lands on the responses the page actually uses
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.addInitScript(instrument)
    const served: string[] = []
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin === ripple && url.pathname.startsWith('/jassub/')) served.push(`${response.status()} ${url.pathname} ${response.headers()['content-type']}`)
    })
    if (framed) {
      const tenant = (url: URL) => url.origin === ripple && (url.pathname === '/watch' || url.pathname.startsWith('/jassub/'))
      await context.route(tenant, async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': TENANT_CSP } })
      })
    }

    let frame = page.mainFrame()
    if (framed) {
      // the same server under another name is another site, and the top document is a plain file of it
      const host = new URL('/README.md', ripple)
      host.hostname = 'localhost'
      await page.goto(host.href)
      await page.evaluate((src) => {
        const iframe = document.createElement('iframe')
        iframe.src = src
        iframe.allow = 'autoplay; fullscreen'
        iframe.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0'
        document.body.append(iframe)
      }, `${ripple}/`)
      await expect.poll(() => page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(ripple))).toBeTruthy()
      frame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(ripple))!
    } else {
      await page.goto('/')
    }
    await watch(page, framed ? page.frameLocator('iframe') : page, frame, file)

    if (framed) {
      // the control for the CSP: a blob worker is refused on /watch, so a pass below means the urls worked
      const blobRefused = await frame.evaluate(() => new Promise<boolean>((resolve) => {
        try {
          const probe = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
          probe.onmessage = () => resolve(false)
          probe.onerror = () => resolve(true)
        } catch { resolve(true) }
      }))
      expect(blobRefused, 'the tenant CSP is not in force on /watch').toBe(true)
    }

    await expect.poll(() => inked(frame), { timeout: 60_000, intervals: [250] }).not.toBeNull()
    const box = (await inked(frame))!
    const { width, height } = box
    expect(box.y1, JSON.stringify(box)).toBeGreaterThan(height / 2)
    expect((box.x1 + box.x2) / 2, JSON.stringify(box)).toBeGreaterThan(width * 0.4)
    expect((box.x1 + box.x2) / 2, JSON.stringify(box)).toBeLessThan(width * 0.6)

    expect(served, 'the wasm script came from /jassub/').toContainEqual(expect.stringMatching(/^200 \/jassub\/jassub-worker(?:-modern)?\.js \w+\/javascript/))
    const violations: string[] = await frame.evaluate(() => (window as any).__violations)
    test.info().annotations.push({ type: 'subtitles', description: JSON.stringify({ box, served, violations }) })
    expect(violations.filter((violation) => !violation.endsWith(' blob')), 'only the probe is refused').toEqual([])
    await context.close()
  })
}
