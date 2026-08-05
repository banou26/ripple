import { useEffect, useRef, useState } from 'react'
import { makeThumbnailer } from 'libav-wasm'

import { terminateRemuxer } from './playback'

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
// avio reads up to the bufferSize below past the slot span; require that margin downloaded
const READAHEAD = 1_000_000
const MAX_ATTEMPTS = 3
// a keyframe decode can hang without ever settling, with no error path
const KEYFRAME_TIMEOUT = 10_000
// grows to MAX_RETRY_DELAY because a torrent that is not moving fails init on every try, and each try costs a wasm worker
const RETRY_DELAY = 5_000
const MAX_RETRY_DELAY = 60_000

// `read` must be a non-prioritizing path so generation never steals download order from playback
export const createThumbnailGenerator = async ({ publicPath, workerUrl, length, read, onThumbnails }: ThumbnailGeneratorOptions) => {
  // a thumbnailer, not a remuxer: readKeyframe seeks backward on the input, which an output muxer cannot
  // follow, and this one has no muxer to damage. It also opens files whose audio the mp4 muxer refuses.
  const remuxer = await makeThumbnailer({
    publicPath,
    workerUrl,
    workerOptions: { type: 'module' },
    length,
    read,
  })
  // the wasm worker is up before init() ever runs, and both init and the index walk below throw on a file
  // that is not readable yet, so the worker has to leave with the failure
  try {
    const metadata = await remuxer.init()
    const duration = metadata.duration

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
    // reading the very last keyframe runs the demuxer into EOF, which crashes the libav build
    if (slots.length > 1 && (slots.at(-1)!.timestamp > duration - INTERVAL * 2)) slots.pop()
    console.warn('[thumbs] ready:', slots.length, 'slots over', Math.round(duration), 's')

    let thumbnails: ThumbnailImage[] = []
    let destroyed = false
    let queue = Promise.resolve()

    // the slider assumes a gapless storyboard, so gaps get empty-url sentinels the skin hides
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
        terminateRemuxer(remuxer)
      },
    }
  } catch (error) {
    terminateRemuxer(remuxer)
    throw error
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
    let delay = RETRY_DELAY
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
        console.warn('[thumbs] init failed, retrying in', Math.round(delay / 1000) + 's:', String(err).slice(0, 140))
        retry = setTimeout(boot, delay)
        delay = Math.min(delay * 2, MAX_RETRY_DELAY)
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
