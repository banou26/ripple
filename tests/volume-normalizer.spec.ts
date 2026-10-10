/*
 * The player's volume normalizer through ripple's own build: a real episode-shaped file made into a torrent on
 * this device, played on /watch, its output read off the graph by an AnalyserNode. The switch starts on from the
 * saved setting and is turned off halfway, so the second half is the control.
 *
 * /watch is served under the fkn.app tenant's CSP (fkn-client `sandbox/src/shared/tenant.ts`), the strictest host
 * ripple runs on: a worklet loaded from a `blob:` or inlined as `data:` is refused there.
 *
 * No network and no transfer: the torrent is complete from the moment it exists, so this is headless.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { NORMALIZE_VOLUME_KEY } from '../src/router/normalize-volume'

const TENANT_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'"

const NAME = 'Normalizer.Episode.mkv'

const ffmpeg = (cwd: string, args: string[]) => {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { cwd, encoding: 'utf8' })
  if (run.error || run.status !== 0) throw new Error(`ffmpeg failed, and this spec needs it on PATH: ${run.error?.message ?? run.stderr}`)
  return run.stderr
}

const integrated = (cwd: string, file: string) => {
  const out = ffmpeg(cwd, ['-i', file, '-af', 'ebur128', '-f', 'null', '-'])
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf('Summary')))![1])
}

/**
 * 44 s at 48 kHz stereo: dialogue at -24 LUFS, a music cue at -16 from 10 s to 20 s and again from 30 s to 40 s.
 * Dialogue is speech-band pink noise under a 4.3 Hz syllable envelope; the cue is a chord with a kick and noise,
 * the brief's synthetic episode cut short.
 */
const makeEpisode = (dir: string) => {
  ffmpeg(dir, [
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=44:seed=7',
    '-f', 'lavfi', '-i', "aevalsrc='(0.2+0.8*pow(0.5-0.5*cos(2*PI*4.3*t),2))*(0.8+0.2*sin(2*PI*0.07*t))':s=48000:d=44",
    '-filter_complex', '[0]highpass=f=200,lowpass=f=3500[n];[n][1]amultiply,pan=stereo|c0=c0|c1=c0',
    '-c:a', 'pcm_f32le', 'dialogue-raw.wav',
  ])
  ffmpeg(dir, [
    '-f', 'lavfi', '-i', "aevalsrc='0.2*(sin(2*PI*110*t)+0.5*sin(2*PI*220*t)+0.6*sin(2*PI*277.18*t)+0.5*sin(2*PI*329.63*t)+0.3*sin(2*PI*440*t))*(0.8+0.2*sin(2*PI*2*t))+0.6*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=10",
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=10:seed=11:amplitude=0.15',
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0',
    '-c:a', 'pcm_f32le', 'music-raw.wav',
  ])
  const dialogueGain = -24 - integrated(dir, 'dialogue-raw.wav')
  const musicGain = -16 - integrated(dir, 'music-raw.wav')
  const piece = (input: number, start: number, length: number, gain: number, label: string) =>
    `[${input}]atrim=start=${start}:duration=${length},asetpts=N/SR/TB,volume=${gain}dB,` +
    `afade=t=in:d=0.01,afade=t=out:st=${length - 0.01}:d=0.01[${label}]`
  ffmpeg(dir, [
    '-i', 'dialogue-raw.wav', '-i', 'music-raw.wav',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=44',
    '-filter_complex', [
      piece(0, 0, 10, dialogueGain, 'a'), piece(1, 0, 10, musicGain, 'b'), piece(0, 10, 10, dialogueGain, 'c'),
      piece(1, 0, 10, musicGain, 'd'), piece(0, 20, 4, dialogueGain, 'e'),
      '[a][b][c][d][e]concat=n=5:v=0:a=1[audio]',
    ].join(';'),
    '-map', '2:v', '-map', '[audio]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-c:a', 'aac', '-b:a', '160k',
    NAME,
  ])
  return join(dir, NAME)
}

/** Taps the normalizer's output, K-weighted (ITU-R BS.1770 at 48 kHz), and samples it every 100 ms with the media time. */
const instrument = () => {
  const w = window as any
  try { localStorage.setItem('ripple:demo-seeded', '1') } catch { /* private mode */ }
  delete w.showDirectoryPicker
  delete w.showOpenFilePicker
  w.__samples = [] as [number, number][]
  // oxlint-disable-next-line typescript/unbound-method
  const connect = AudioNode.prototype.connect as (this: AudioNode, target: any, ...rest: any[]) => any
  AudioNode.prototype.connect = function (this: AudioNode, target: any, ...rest: any[]) {
    if (target instanceof AudioDestinationNode && this instanceof AudioWorkletNode && !w.__analyser) {
      const context = this.context
      w.__sampleRate = context.sampleRate
      const stages: [number[], number[]][] = [
        [[1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]],
        [[1, -2, 1], [1, -1.99004745483398, 0.99007225036621]],
      ]
      const weighted = stages.reduce<AudioNode>(
        (node, [feedforward, feedback]) => connect.call(node, new IIRFilterNode(context, { feedforward, feedback })),
        this,
      )
      const analyser = connect.call(weighted, new AnalyserNode(context, { fftSize: 4096 })) as AnalyserNode
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
      }, 100)
    }
    return connect.call(this, target, ...rest)
  } as any
}

/** Loudness over a span of media time, gated at -70 like BS.1770, from the 85 ms reads above. */
const loudness = (samples: [number, number][], from: number, to: number) => {
  const inside = samples.filter(([t, ms]) => t >= from && t < to && -0.691 + 10 * Math.log10(ms) > -70)
  expect(inside.length, `no reads between ${from} s and ${to} s`).toBeGreaterThan(20)
  return -0.691 + 10 * Math.log10(inside.reduce((a, [, ms]) => a + ms, 0) / inside.length)
}

test('the cue is held to the dialogue with the switch on, and keeps its lead off', async ({ browser }) => {
  test.setTimeout(300_000)
  const dir = test.info().outputPath()
  const file = makeEpisode(dir)
  ffmpeg(dir, ['-i', NAME, '-ss', '0', '-t', '10', '-vn', 'dialogue.wav'])
  ffmpeg(dir, ['-i', NAME, '-ss', '10', '-t', '10', '-vn', 'cue.wav'])
  const lead = integrated(dir, 'cue.wav') - integrated(dir, 'dialogue.wav')
  expect(lead, 'the file itself has to carry a louder cue').toBeGreaterThan(6)

  // no service worker, so the CSP below lands on the document /watch actually renders
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.addInitScript(instrument)
  await page.addInitScript((key) => { try { localStorage.setItem(key, '1') } catch {} }, NORMALIZE_VOLUME_KEY)
  await page.route((url) => url.pathname === '/watch', async (route) => {
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
  await expect(dialog.getByText('Ripple kept its own copy')).toBeVisible({ timeout: 120_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()
  const watch = page.getByRole('link', { name: `Watch ${NAME}` })
  await expect(watch).toBeVisible({ timeout: 120_000 })
  await page.goto((await watch.getAttribute('href'))!)

  // the control for the CSP: the prototype's blob worklet is refused here, so a pass below means the url worked
  const blobRefused = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['registerProcessor("probe", class extends AudioWorkletProcessor { process() { return true } })'], { type: 'text/javascript' }))
    try { await new AudioContext().audioWorklet.addModule(url); return false } catch { return true }
  })
  expect(blobRefused, 'the tenant CSP is not in force on /watch').toBe(true)

  await expect.poll(() => page.evaluate(() => !!(window as any).__analyser), { timeout: 60_000 }).toBe(true)
  expect(await page.evaluate(() => (window as any).__sampleRate)).toBe(48000)
  // opens the settings menu when the switch is not on screen, and reads or flips it
  const normalizeSwitch = (flip: boolean) => page.evaluate(async (flip) => {
    const find = () => document.querySelector<HTMLElement>('[role="switch"]')
    if (!find()) (document.querySelector('button.settings') as HTMLElement).click()
    for (let i = 0; i < 20 && !find(); i++) await new Promise((done) => setTimeout(done, 50))
    if (flip) find()?.click()
    await new Promise((done) => setTimeout(done, 50))
    return find()?.getAttribute('aria-checked')
  }, flip)
  expect(await normalizeSwitch(false), 'the saved setting did not reach the player').toBe('true')

  const at = (seconds: number) => expect.poll(
    () => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0),
    { timeout: 90_000, intervals: [250] },
  ).toBeGreaterThan(seconds)
  await at(20.5)
  expect(await normalizeSwitch(true)).toBe('false')
  expect(await page.evaluate((key) => localStorage.getItem(key), NORMALIZE_VOLUME_KEY)).toBe('0')
  await at(40.5)

  const samples: [number, number][] = await page.evaluate(() => (window as any).__samples)
  const on = { dialogue: loudness(samples, 4, 10), cue: loudness(samples, 14, 20) }
  const off = { dialogue: loudness(samples, 24, 30), cue: loudness(samples, 34, 40) }
  test.info().annotations.push({
    type: 'loudness',
    description: JSON.stringify({ file: lead, on, off, leadOn: on.cue - on.dialogue, leadOff: off.cue - off.dialogue }),
  })
  expect(off.cue - off.dialogue, 'the control: off, the cue keeps its lead').toBeGreaterThan(5)
  expect(Math.abs(on.cue - on.dialogue), 'on, the cue is held to the dialogue').toBeLessThan(2)
  await context.close()
})
