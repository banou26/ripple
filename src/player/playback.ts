import type { AudioStream } from 'libav-wasm/build/worker'

import { makeRemuxer } from 'libav-wasm'

import { getTimeRanges, updateSourceBuffer } from './source-buffer'
import { createSubtitleRenderer } from './subtitles'
import type { SubtitleStream } from './subtitles'

export type { AudioStream }

export type PlaybackOptions = {
  videoElement: HTMLVideoElement
  canvasElement: HTMLCanvasElement
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  length: number
  publicPath: string
  libavWorkerUrl: string
  jassubWorkerUrl: string
  jassubWasmUrl: string
  defaultFontUrl: string
  bufferSize?: number
  audioStreamIndex?: number
  onReady?: () => void
  onError?: (error: unknown) => void
  // Fires on every seek with the target as a fraction of the duration, before
  // the remuxer starts reading there - lets the torrent layer re-prioritize.
  onSeek?: (fraction: number) => void
  onSubtitleStreams?: (streams: SubtitleStream[]) => void
  onAudioStreams?: (streams: AudioStream[], selected: number) => void
}

export type PlaybackController = {
  destroy: () => void
  selectSubtitleStream: (streamIndex: number) => void
}

// Keep ~20s behind / ~60s ahead of the playhead buffered; refill when the
// forward buffer dips under 30s. Matches the proven media-player tuning.
const PRE_EVICT = -20
const POST_EVICT = 60
const BUFFER_TARGET = 30

export const startPlayback = async (options: PlaybackOptions): Promise<PlaybackController> => {
  const {
    videoElement, canvasElement, read, length, publicPath, libavWorkerUrl,
    jassubWorkerUrl, jassubWasmUrl, defaultFontUrl, bufferSize = 2_500_000,
    audioStreamIndex, onReady, onError, onSeek, onSubtitleStreams, onAudioStreams,
  } = options

  // ES-module worker: the emscripten glue uses import.meta.url, invalid in a
  // classic importScripts worker, so we load it as a real module worker.
  const remuxer = await makeRemuxer({
    publicPath,
    workerUrl: libavWorkerUrl,
    workerOptions: { type: 'module' },
    bufferSize,
    length,
    audioStreamIndex,
    read,
  })

  const metadata = await remuxer.init()

  const audioStreams = metadata.audioStreams ?? []
  const selectedAudio = audioStreams.some((s) => s.streamIndex === audioStreamIndex)
    ? audioStreamIndex!
    : audioStreams[0]?.streamIndex ?? -1
  onAudioStreams?.(audioStreams, selectedAudio)

  const subtitles = createSubtitleRenderer({
    video: videoElement,
    canvas: canvasElement,
    publicPath,
    workerUrl: jassubWorkerUrl,
    wasmUrl: jassubWasmUrl,
    defaultFontUrl,
  })
  if (onSubtitleStreams) subtitles.setOnStreams(onSubtitleStreams)
  if (metadata.attachments?.length) subtitles.pushAttachments(metadata.attachments)

  const mediaSource = new MediaSource()
  const mediaSourceUrl = URL.createObjectURL(mediaSource)
  videoElement.src = mediaSourceUrl

  const sourceBuffer = await new Promise<SourceBuffer>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => {
      const codecs = [metadata.info.output.videoMimeType, metadata.info.output.audioMimeType].filter(Boolean).join(',')
      const sb = mediaSource.addSourceBuffer(`video/mp4; codecs="${codecs}"`)
      sb.mode = 'segments'
      mediaSource.duration = metadata.info.input.duration
      resolve(sb)
    }, { once: true })
  })

  const { appendBuffer, unbufferRange, updateTimestampOffset } = updateSourceBuffer(sourceBuffer)
  await appendBuffer(metadata.data)
  if (metadata.subtitles?.length) subtitles.pushFragments(metadata.subtitles)
  onReady?.()

  let reading = false
  let seeking = false
  let finished = false
  let destroyed = false

  const evict = async () => {
    const ct = videoElement.currentTime
    for (const { start, end } of getTimeRanges(sourceBuffer)) {
      if (start < ct + PRE_EVICT) await unbufferRange(start, ct + PRE_EVICT)
      if (end > ct + POST_EVICT) await unbufferRange(ct + POST_EVICT, end)
    }
  }

  const needsData = () => {
    const ranges = getTimeRanges(sourceBuffer)
    const maxEnd = ranges.length ? Math.max(...ranges.map((r) => r.end)) : -Infinity
    return maxEnd < videoElement.currentTime + BUFFER_TARGET
  }

  const pump = async () => {
    if (reading || seeking || finished || destroyed || !needsData()) return
    reading = true
    try {
      const { data, subtitles: fragments, finished: done } = await remuxer.read()
      if (done) finished = true
      if (fragments?.length) subtitles.pushFragments(fragments)
      if (data.byteLength) await appendBuffer(data)
    } catch (error) {
      if ((error as Error)?.message !== 'Cancelled') console.error(error)
    } finally {
      reading = false
    }
  }

  const onSeeking = async () => {
    finished = false
    seeking = true
    const duration = metadata.info.input.duration || videoElement.duration
    if (duration > 0) onSeek?.(Math.min(Math.max(videoElement.currentTime / duration, 0), 1))
    try {
      const { data, pts, subtitles: fragments } = await remuxer.seek(videoElement.currentTime)
      if (fragments?.length) subtitles.pushFragments(fragments)
      await updateTimestampOffset(pts)
      if (data.byteLength) await appendBuffer(data)
    } catch (error) {
      if ((error as Error)?.message !== 'Cancelled') console.error(error)
    } finally {
      seeking = false
    }
  }
  videoElement.addEventListener('seeking', onSeeking)

  const interval = setInterval(() => {
    evict().catch(() => {})
    pump().catch((error) => onError?.(error))
  }, 100)

  return {
    destroy: () => {
      destroyed = true
      clearInterval(interval)
      videoElement.removeEventListener('seeking', onSeeking)
      subtitles.destroy()
      try { remuxer.destroy() } catch {}
      try { URL.revokeObjectURL(mediaSourceUrl) } catch {}
    },
    selectSubtitleStream: (streamIndex: number) => subtitles.selectStream(streamIndex),
  }
}
