/*
 * The player's volume normalizer through ripple's own build: an episode-shaped file made into a torrent on this
 * device, played on /watch, its output read off the graph by an AnalyserNode. Nothing is saved, so the switch starts
 * on, and it is turned off halfway: the second half is the same audio as the first, and the control.
 *
 * /watch and the normalizer's worker are served under the fkn.app tenant's CSP (fkn-client
 * `sandbox/src/shared/tenant.ts`), the strictest host ripple runs on: a worklet or a worker from a `blob:` is refused
 * there, and a same-origin worker takes its policy from its own response. libav's worker is left without it, since
 * its embind glue builds functions from strings, which that policy refuses (measured 2026-10-17, libav-wasm 0.8.10).
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { NORMALIZE_VOLUME_KEY } from '../src/router/normalize-volume'

const TENANT_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'"

const NAME = 'Normalizer.Episode.mkv'
const HALF = 22
// one second each, in either half
const BURSTS = [8, 13, 18]

const ffmpeg = (cwd: string, args: string[]) => {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { cwd, encoding: 'utf8' })
  if (run.error || run.status !== 0) throw new Error(`ffmpeg failed, and this spec needs it on PATH: ${run.error?.message ?? run.stderr}`)
  return run.stderr
}

const integrated = (cwd: string, file: string, from?: number, seconds?: number) => {
  const span = from === undefined ? [] : ['-ss', String(from), '-t', String(seconds)]
  const out = ffmpeg(cwd, [...span, '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'])
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf('Summary')))![1])
}

/**
 * 44 s at 48 kHz stereo, two identical halves: dialogue at -24 LUFS throughout, and a one second burst at -9 LUFS
 * (a chord with a kick and noise) laid over it at each of `BURSTS`. Dialogue is speech-band pink noise under a
 * 4.3 Hz syllable envelope.
 */
const makeEpisode = (dir: string) => {
  ffmpeg(dir, [
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:sample_rate=48000:duration=${HALF}:seed=7`,
    '-f', 'lavfi', '-i', `aevalsrc='(0.2+0.8*pow(0.5-0.5*cos(2*PI*4.3*t),2))*(0.8+0.2*sin(2*PI*0.07*t))':s=48000:d=${HALF}`,
    '-filter_complex', '[0]highpass=f=200,lowpass=f=3500[n];[n][1]amultiply,pan=stereo|c0=c0|c1=c0',
    '-c:a', 'pcm_f32le', 'dialogue-raw.wav',
  ])
  ffmpeg(dir, [
    '-f', 'lavfi', '-i', "aevalsrc='0.2*(sin(2*PI*110*t)+0.5*sin(2*PI*220*t)+0.6*sin(2*PI*277.18*t)+0.5*sin(2*PI*329.63*t)+0.3*sin(2*PI*440*t))*(0.8+0.2*sin(2*PI*2*t))+0.6*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=10",
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=10:seed=11:amplitude=0.15',
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0',
    '-c:a', 'pcm_f32le', 'burst-raw.wav',
  ])
  const dialogueGain = -24 - integrated(dir, 'dialogue-raw.wav')
  const burstGain = -9 - integrated(dir, 'burst-raw.wav')
  const starts = [...BURSTS, ...BURSTS.map((start) => start + HALF)]
  ffmpeg(dir, [
    '-i', 'dialogue-raw.wav', '-i', 'burst-raw.wav',
    '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${2 * HALF}`,
    '-filter_complex', [
      `[0]volume=${dialogueGain}dB,asplit[d0][d1]`,
      '[d0][d1]concat=n=2:v=0:a=1[dialogue]',
      `[1]atrim=duration=1,asetpts=N/SR/TB,volume=${burstGain}dB,afade=t=in:d=0.01,afade=t=out:st=0.99:d=0.01,` +
        `asplit=${starts.length}${starts.map((_, i) => `[b${i}]`).join('')}`,
      ...starts.map((start, i) => `[b${i}]adelay=delays=${start * 1000}:all=1[c${i}]`),
      `[dialogue]${starts.map((_, i) => `[c${i}]`).join('')}amix=inputs=${starts.length + 1}:normalize=0:duration=first[audio]`,
    ].join(';'),
    '-map', '2:v', '-map', '[audio]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-c:a', 'aac', '-b:a', '160k',
    NAME,
  ])
  return join(dir, NAME)
}

/**
 * Taps the normalizer's output, K-weighted (ITU-R BS.1770), and samples it every 50 ms with the media time; keeps
 * what the normalizer's analysis worker reports, and every CSP violation the document sees.
 */
const instrument = () => {
  const w = window as any
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  delete w.showDirectoryPicker
  delete w.showOpenFilePicker
  w.__samples = [] as [number, number][]
  w.__violations = [] as string[]
  document.addEventListener('securitypolicyviolation', (event) => w.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`))
  const NativeWorker = Worker
  w.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      if (!String(url).includes('volume-normalizer-worklet')) return
      w.__analysis = { url: String(url), report: null, unsupported: false, error: null }
      this.addEventListener('message', ({ data }) => {
        if (data?.spans) w.__analysis.report = data
        if (data?.type === 'unsupported') w.__analysis.unsupported = true
      })
      this.addEventListener('error', (event) => { w.__analysis.error = event.message || 'error' })
    }
  }
  // oxlint-disable-next-line typescript/unbound-method
  const connect = AudioNode.prototype.connect as (this: AudioNode, target: any, ...rest: any[]) => any
  AudioNode.prototype.connect = function (this: AudioNode, target: any, ...rest: any[]) {
    if (target instanceof AudioDestinationNode && this instanceof AudioWorkletNode && !w.__analyser) {
      const context = this.context
      w.__sampleRate = context.sampleRate
      // K-weighting at the context's own rate, which follows the output device (44.1 kHz on a CI runner), in the
      // bilinear form libebur128 uses: at 48 kHz it gives BS.1770's published coefficients to 1e-15
      const biquad = (f0: number, q: number, vh: number, vb: number): [number[], number[]] => {
        const k = Math.tan(Math.PI * f0 / context.sampleRate)
        const a0 = 1 + k / q + k * k
        return [
          [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
          [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0],
        ]
      }
      const vh = Math.pow(10, 3.999843853973347 / 20)
      const stages: [number[], number[]][] = [
        biquad(1681.974450955533, 0.7071752369554196, vh, Math.pow(vh, 0.4996667741545416)),
        [[1, -2, 1], biquad(38.13547087602444, 0.5003270373238773, 1, 0)[1]],
      ]
      const weighted = stages.reduce<AudioNode>(
        (node, [feedforward, feedback]) => connect.call(node, new IIRFilterNode(context, { feedforward, feedback })),
        this,
      )
      const analyser = connect.call(weighted, new AnalyserNode(context, { fftSize: 2048 })) as AnalyserNode
      connect.call(connect.call(analyser, new GainNode(context, { gain: 0 })), context.destination)
      w.__analyser = analyser
      setInterval(() => {
        const video = document.querySelector('video')
        if (!video || video.paused) return
        const data = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += v * v
        w.__samples.push([video.currentTime, sum / data.length])
      }, 50)
    }
    return connect.call(this, target, ...rest)
  } as any
}

type Span = [number, number]

/** Loudness over spans of media time, gated at -70 like BS.1770, from the 2048 frame reads above. */
const loudness = (samples: [number, number][], spans: Span[]) => {
  const inside = samples.filter(([t, ms]) => spans.some(([from, to]) => t >= from && t < to) && -0.691 + 10 * Math.log10(ms) > -70)
  expect(inside.length, `too few reads in ${JSON.stringify(spans)}`).toBeGreaterThan(30)
  return -0.691 + 10 * Math.log10(inside.reduce((a, [, ms]) => a + ms, 0) / inside.length)
}

// the middle of each burst, and the dialogue from half a second after one to half a second before the next
const burstSpans = (offset: number): Span[] => BURSTS.map((start) => [offset + start + 0.2, offset + start + 0.9])
const dialogueSpans = (offset: number): Span[] => [
  [offset + 3, offset + BURSTS[0]! - 0.5],
  ...BURSTS.map((start, i): Span => [offset + start + 1.5, offset + (BURSTS[i + 1] ?? HALF) - 0.5]),
]

test('short bursts are held and the dialogue is left as it is, on by default, and off is the control', async ({ browser, baseURL }) => {
  test.setTimeout(300_000)
  const dir = test.info().outputPath()
  const file = makeEpisode(dir)
  const lead = integrated(dir, NAME, BURSTS[0], 1) - integrated(dir, NAME, 2, 5)
  expect(lead, 'the file itself has to carry louder bursts').toBeGreaterThan(12)

  // no service worker, so the CSP below lands on the document /watch actually renders
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.addInitScript(instrument)
  const tenant = (url: URL) => url.origin === new URL(baseURL!).origin
    && (url.pathname === '/watch' || url.pathname === '/volume-normalizer-worklet.js')
  await page.route(tenant, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': TENANT_CSP } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Create a torrent' }).click()
  const dialog = page.getByRole('dialog')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose a file', exact: true }).click()
  await (await chooser).setFiles(file)
  await dialog.getByRole('button', { name: 'Create and start sharing' }).click()
  await expect(dialog.locator('[data-outcome="copied"]')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()
  const watch = page.getByRole('link', { name: `Watch ${NAME}` })
  await expect(watch).toBeVisible({ timeout: 120_000 })
  await page.goto((await watch.getAttribute('href'))!)
  expect(await page.evaluate((key) => localStorage.getItem(key), NORMALIZE_VOLUME_KEY), 'nothing saved').toBeNull()

  // the control for the CSP: a blob worklet and a blob worker are refused here, so a pass below means the urls worked
  const blobRefused = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['registerProcessor("probe", class extends AudioWorkletProcessor { process() { return true } })'], { type: 'text/javascript' }))
    let worklet = false
    try { await new AudioContext().audioWorklet.addModule(url) } catch { worklet = true }
    // Chrome refuses a worker's url when it fetches it, after the constructor has returned
    const worker = await new Promise<boolean>((resolve) => {
      try {
        const probe = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
        probe.onmessage = () => resolve(false)
        probe.onerror = () => resolve(true)
      } catch { resolve(true) }
    })
    return { worklet, worker }
  })
  expect(blobRefused, 'the tenant CSP is not in force on /watch').toEqual({ worklet: true, worker: true })

  await expect.poll(() => page.evaluate(() => !!(window as any).__analyser), { timeout: 60_000 }).toBe(true)
  // opens the settings menu when the switch is not on screen, and reads or flips it
  const normalizeSwitch = (flip: boolean) => page.evaluate(async (flip) => {
    const find = () => document.querySelector<HTMLElement>('[role="switch"]')
    if (!find()) (document.querySelector('button.settings') as HTMLElement).click()
    for (let i = 0; i < 20 && !find(); i++) await new Promise((done) => setTimeout(done, 50))
    if (flip) find()?.click()
    await new Promise((done) => setTimeout(done, 50))
    return find()?.getAttribute('aria-checked')
  }, flip)
  expect(await normalizeSwitch(false), 'on with nothing saved').toBe('true')

  const at = (seconds: number) => expect.poll(
    () => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0),
    { timeout: 90_000, intervals: [250] },
  ).toBeGreaterThan(seconds)
  await at(HALF + 0.5)
  // analysed under the tenant CSP by the worker the worklet's own file starts, across the whole file
  const analysis = await page.evaluate(() => (window as any).__analysis)
  expect(analysis?.url, 'the analysis worker never started').toContain('/volume-normalizer-worklet.js')
  expect(analysis.error).toBeNull()
  expect(analysis.unsupported).toBe(false)
  const analysed = (analysis.report?.spans ?? []).reduce((total: number, [from, to]: Span) => total + to - from, 0)
  expect(analysed, JSON.stringify(analysis.report)).toBeGreaterThan(2 * HALF - 1)
  expect(await normalizeSwitch(true)).toBe('false')
  expect(await page.evaluate((key) => localStorage.getItem(key), NORMALIZE_VOLUME_KEY)).toBe('0')
  await at(2 * HALF - 0.4)

  const samples: [number, number][] = await page.evaluate(() => (window as any).__samples)
  const on = { dialogue: loudness(samples, dialogueSpans(0)), bursts: loudness(samples, burstSpans(0)) }
  const off = { dialogue: loudness(samples, dialogueSpans(HALF)), bursts: loudness(samples, burstSpans(HALF)) }
  const violations: string[] = await page.evaluate(() => (window as any).__violations)
  test.info().annotations.push({
    type: 'loudness',
    description: JSON.stringify({
      sampleRate: await page.evaluate(() => (window as any).__sampleRate),
      file: lead, on, off, leadOn: on.bursts - on.dialogue, leadOff: off.bursts - off.dialogue, analysed, violations,
    }),
  })
  expect(violations.filter((violation) => !violation.endsWith(' blob')), 'only the probes are refused').toEqual([])
  expect(off.bursts - off.dialogue, 'the control: off, the bursts keep their lead').toBeGreaterThan(12)
  expect(off.bursts - on.bursts, 'on, the bursts are turned down').toBeGreaterThan(4)
  expect(on.bursts - on.dialogue, 'on, the bursts are held under the dialogue plus the headroom').toBeLessThan(11)
  expect(Math.abs(on.dialogue - off.dialogue), 'on, the dialogue is left as it is').toBeLessThan(1)
  await context.close()
})
