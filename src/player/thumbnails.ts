import { useEffect, useRef, useState } from 'react'
import { makeRemuxer } from 'libav-wasm'

export type ThumbnailImage = { url: string, startTime: number, endTime: number }

export type ThumbnailGeneratorOptions = {
  publicPath: string
  workerUrl: string
  length: number
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  onThumbnails: (thumbnails: ThumbnailImage[]) => void
}

const INTERVAL = 5
const WIDTH = 320
// avio fills its buffer from the seek position, so a keyframe read can touch
// up to bufferSize bytes past the slot span; require that margin downloaded.
const READAHEAD = 1_000_000
const MAX_ATTEMPTS = 3
// A keyframe decode can hang without ever settling (decoder never emits, no
// error path); time it out so the queue keeps moving - the next call aborts
// the stuck one inside libav.
const KEYFRAME_TIMEOUT = 10_000

// Second remuxer dedicated to seekbar previews: one keyframe per INTERVAL
// seconds, decoded to a downscaled webp once its byte span is downloaded.
// Reads must come in through a non-prioritizing path so generation never
// steals download order from playback.
export const createThumbnailGenerator = async ({ publicPath, workerUrl, length, read, onThumbnails }: ThumbnailGeneratorOptions) => {
  const remuxer = await makeRemuxer({
    publicPath,
    workerUrl,
    workerOptions: { type: 'module' },
    bufferSize: 1_000_000,
    length,
    read,
  })
  const metadata = await remuxer.init()
  const duration = metadata.info.input.duration

  type Slot = { timestamp: number, endTime: number, startByte: number, endByte: number, done: boolean, attempts: number }
  const slots: Slot[] = []
  for (const [i, index] of metadata.indexes.entries()) {
    const last = slots.at(-1)
    if (last && index.timestamp - last.timestamp < INTERVAL) continue
    slots.push({
      timestamp: index.timestamp,
      endTime: duration,
      startByte: index.pos,
      endByte: Math.min((metadata.indexes[i + 1]?.pos ?? length) + READAHEAD, length),
      done: false,
      attempts: 0,
    })
  }
  for (const [i, slot] of slots.entries()) slot.endTime = slots[i + 1]?.timestamp ?? duration
  // Reading the very last keyframe runs the demuxer into EOF, which crashes
  // the current libav build; the closing-credits thumb is not worth it.
  if (slots.length > 1 && (slots.at(-1)!.timestamp > duration - INTERVAL * 2)) slots.pop()
  console.warn('[thumbs] ready:', slots.length, 'slots over', Math.round(duration), 's')

  let thumbnails: ThumbnailImage[] = []
  let destroyed = false
  let queue = Promise.resolve()

  // The slider matches hover time to the LAST entry with startTime <= time
  // (endTime is ignored - the contract assumes a gapless storyboard), so
  // not-yet-generated stretches are covered by empty-url sentinels: a gap
  // hover would otherwise show whichever thumbnail came before it. The skin
  // CSS hides the whole preview window while the sentinel is active.
  const emit = () => {
    const display: ThumbnailImage[] = []
    for (const [i, t] of thumbnails.entries()) {
      if (t.startTime - (display.at(-1)?.endTime ?? 0) > 0.01) {
        display.push({ url: '', startTime: display.at(-1)?.endTime ?? 0, endTime: t.startTime })
      }
      display.push(t)
      const next = thumbnails[i + 1]
      if (next && next.startTime - t.endTime > 0.01) {
        display.push({ url: '', startTime: t.endTime, endTime: next.startTime })
      }
    }
    const tailEnd = display.at(-1)?.endTime ?? 0
    if (duration - tailEnd > 0.01) display.push({ url: '', startTime: tailEnd, endTime: duration })
    onThumbnails(display)
  }

  let generated = 0
  const generate = (slot: Slot) => {
    slot.done = true
    queue = queue
      .then(async () => {
        if (destroyed) return
        const png = await Promise.race([
          remuxer.readKeyframe(slot.timestamp),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), KEYFRAME_TIMEOUT)),
        ])
        const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(WIDTH, Math.max(1, Math.round(bitmap.height * (WIDTH / bitmap.width))))
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 })
        if (destroyed) return
        thumbnails = [...thumbnails, { url: URL.createObjectURL(blob), startTime: slot.timestamp, endTime: slot.endTime }]
          .sort((a, b) => a.startTime - b.startTime)
        generated += 1
        if (generated === 1 || generated % 50 === 0) console.warn('[thumbs] generated', generated, '/', slots.length)
        emit()
      })
      .catch((err) => {
        slot.attempts += 1
        slot.done = slot.attempts >= MAX_ATTEMPTS
        if (!destroyed) console.warn('[thumbs] keyframe', slot.timestamp.toFixed(1) + 's', 'attempt', slot.attempts, String(err).slice(0, 140))
      })
  }

  emit()

  return {
    // Byte ranges of the file known to be fully downloaded; generates every
    // not-yet-done slot whose span is covered.
    update: (ranges: [number, number][]) => {
      if (destroyed) return
      for (const slot of slots) {
        if (slot.done) continue
        if (ranges.some(([from, to]) => from <= slot.startByte && slot.endByte <= to)) generate(slot)
      }
    },
    destroy: () => {
      destroyed = true
      for (const t of thumbnails) URL.revokeObjectURL(t.url)
      thumbnails = []
      try { remuxer.destroy() } catch {}
    },
  }
}

export const useSeekThumbnails = ({ enabled, publicPath, workerUrl, length, read, ranges }: {
  enabled: boolean
  publicPath: string
  workerUrl: string
  length: number | undefined
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  ranges: [number, number][]
}): ThumbnailImage[] => {
  const [thumbnails, setThumbnails] = useState<ThumbnailImage[]>([])
  const genRef = useRef<Awaited<ReturnType<typeof createThumbnailGenerator>> | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const rangesRef = useRef(ranges)
  rangesRef.current = ranges

  useEffect(() => {
    if (!enabled || !length) return
    let cancelled = false
    let gen: Awaited<ReturnType<typeof createThumbnailGenerator>> | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const boot = () => {
      createThumbnailGenerator({
        publicPath,
        workerUrl,
        length,
        read: (offset, size) => readRef.current(offset, size),
        onThumbnails: (t) => { if (!cancelled) setThumbnails(t) },
      }).then((g) => {
        if (cancelled) { g.destroy(); return }
        gen = g
        genRef.current = g
        g.update(rangesRef.current)
      }, (err) => {
        if (cancelled) return
        console.warn('[thumbs] init failed, retrying:', String(err).slice(0, 140))
        retry = setTimeout(boot, 5_000)
      })
    }
    boot()
    return () => {
      cancelled = true
      clearTimeout(retry)
      genRef.current = null
      gen?.destroy()
      setThumbnails([])
    }
  }, [enabled, length, publicPath, workerUrl])

  useEffect(() => { genRef.current?.update(ranges) }, [ranges])

  return thumbnails
}
