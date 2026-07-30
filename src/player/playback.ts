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
  // Fires once the pump appends again after a reported failure, so a transient
  // read that healed itself does not leave its message on screen forever.
  onRecovered?: () => void
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
// Window used after the browser refuses an append: keep only what is about to
// be played, then resume the stream at the far edge of what was kept.
const PRE_EVICT_TIGHT = -5
const POST_EVICT_TIGHT = 20
// A segment that still will not go in after this many ticks is reported rather
// than retried forever.
const MAX_APPEND_ATTEMPTS = 5
// A MediaSource that never reaches 'sourceopen' would otherwise hang the whole
// start-up await with nothing on screen.
const SOURCE_OPEN_TIMEOUT = 15_000
// How far past the playhead a buffered range may start and still count as the
// one holding it. Browsers jump gaps this small on their own.
const BOUNDARY_SLACK = 1

// destroy() terminates the worker only after an awaited round trip into the
// wasm, so a rejected or hung call would strand an ~18MB worker for the life of
// the tab; terminate on our own clock either way.
export const terminateRemuxer = (remuxer: { worker: Worker, destroy: () => Promise<void> }) => {
  const { worker } = remuxer
  const bail = setTimeout(() => worker.terminate(), 2_000)
  void remuxer
    .destroy()
    .catch(() => {})
    .finally(() => {
      clearTimeout(bail)
      worker.terminate()
    })
}

export const startPlayback = async (options: PlaybackOptions): Promise<PlaybackController> => {
  const {
    videoElement, canvasElement, read, length, publicPath, libavWorkerUrl,
    jassubWorkerUrl, jassubWasmUrl, defaultFontUrl, bufferSize = 2_500_000,
    audioStreamIndex, onReady, onError, onRecovered, onSeek, onSubtitleStreams,
    onAudioStreams,
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

  // Everything built past this point registers its own undo as it is created,
  // so a failure half way through cannot strand the wasm worker, the subtitle
  // worker or the object URL. The returned destroy() runs the same list.
  const teardown: (() => void)[] = []
  let destroyed = false
  const runTeardown = () => {
    if (destroyed) return
    destroyed = true
    for (const step of [...teardown].reverse()) {
      try { step() } catch {}
    }
  }
  teardown.push(() => terminateRemuxer(remuxer))

  try {
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
    teardown.push(() => subtitles.destroy())
    if (onSubtitleStreams) subtitles.setOnStreams(onSubtitleStreams)
    if (metadata.attachments?.length) subtitles.pushAttachments(metadata.attachments)

    // libav is remux-only, so the muxer hands back whatever the file carries:
    // hev1, vp09, ac-3 and friends never load in a Chrome MediaSource. Refuse
    // up front instead of waiting on a 'sourceopen' that can only throw.
    const codecs = [metadata.info.output.videoMimeType, metadata.info.output.audioMimeType].filter(Boolean).join(',')
    const mime = `video/mp4; codecs="${codecs}"`
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`This browser cannot play the codecs in this file: ${codecs}`)

    const mediaSource = new MediaSource()
    const mediaSourceUrl = URL.createObjectURL(mediaSource)
    teardown.push(() => URL.revokeObjectURL(mediaSourceUrl))
    videoElement.src = mediaSourceUrl

    const sourceBuffer = await new Promise<SourceBuffer>((resolve, reject) => {
      // The listener runs long after the executor returned, so anything it
      // throws is lost and the await never settles unless it rejects by hand.
      const timeout = setTimeout(() => { cleanup(); reject(new Error('The MediaSource never opened')) }, SOURCE_OPEN_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timeout)
        mediaSource.removeEventListener('sourceopen', onSourceOpen)
        mediaSource.removeEventListener('sourceclose', onFail)
        mediaSource.removeEventListener('error', onFail)
      }
      const onSourceOpen = () => {
        try {
          const sb = mediaSource.addSourceBuffer(mime)
          sb.mode = 'segments'
          // Assigning a non-finite duration throws, and an unknown duration is
          // still worth playing, so only set one the element can hold.
          const duration = metadata.info.input.duration
          if (Number.isFinite(duration) && duration > 0) mediaSource.duration = duration
          cleanup()
          resolve(sb)
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const onFail = () => { cleanup(); reject(new Error('The MediaSource closed before a SourceBuffer could be created')) }
      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true })
      mediaSource.addEventListener('sourceclose', onFail, { once: true })
      mediaSource.addEventListener('error', onFail, { once: true })
    })

    const { appendBuffer, unbufferRange, updateTimestampOffset, endOfStream } = updateSourceBuffer(sourceBuffer, mediaSource)
    await appendBuffer(metadata.data)
    if (metadata.subtitles?.length) subtitles.pushFragments(metadata.subtitles)
    onReady?.()

    let reading = false
    let seeking = false
    let finished = false
    // libav aborts the running task whenever a new one starts, so both flags
    // are held by a generation token: a stale task must not clear the flag its
    // successor now owns, nor append against the successor's timeline.
    let readGeneration = 0
    let seekGeneration = 0
    let pending: ArrayBuffer | null = null
    let pendingAttempts = 0
    let lastAppendedEnd = 0
    // A failure already on screen: the pump would otherwise re-report the same
    // one ten times a second, and nothing would ever take the message down.
    let outstandingError = false

    // libav rejects with 'Cancelled' both for a task another task aborted and
    // for a read of the file that gave up, so it only counts as noise while a
    // seek or a teardown is actually in flight; otherwise it is a real failure
    // wearing a misleading message.
    const reportError = (error: unknown, aborted: boolean) => {
      const cancelled = (error as Error)?.message === 'Cancelled'
      if (aborted && cancelled) return
      console.error(error)
      if (outstandingError) return
      outstandingError = true
      onError?.(cancelled ? new Error('Reading the video file failed', { cause: error }) : error)
    }

    const evict = async (tight = false) => {
      const ct = videoElement.currentTime
      const pre = tight ? PRE_EVICT_TIGHT : PRE_EVICT
      const post = tight ? POST_EVICT_TIGHT : POST_EVICT
      for (const { start, end } of getTimeRanges(sourceBuffer)) {
        if (start < ct + pre) await unbufferRange(start, ct + pre)
        if (end > ct + post) await unbufferRange(ct + post, end)
      }
    }

    // Only the range holding the playhead counts. A backward seek into already
    // buffered content appends one segment and leaves a hole up to the old
    // forward range, whose end would otherwise read as a full buffer and stop
    // the pump for good, since a stalled currentTime can never clear it. The
    // far range is gone within a tick or two of evict(), so the pump resumes
    // reading from where the playhead actually is.
    //
    // The slack matters: the first media segment often starts a fraction of a
    // second after zero (audio priming), and a strictly-contains test would read
    // that as an empty buffer and pump the whole file in.
    //
    // The ceiling on the furthest buffered end is what keeps that same hole from
    // becoming a runaway: with the playhead stuck behind a gap its own range
    // never grows, so without a ceiling the pump would read the rest of the file
    // while evict() throws every segment away just after it lands.
    const needsData = () => {
      const ranges = getTimeRanges(sourceBuffer)
      if (!ranges.length) return true
      const ct = videoElement.currentTime
      // Never read past what evict() keeps: those bytes are discarded on the next tick.
      if (Math.max(...ranges.map((r) => r.end)) >= ct + POST_EVICT) return false
      const range = ranges.find((r) => r.start <= ct + BOUNDARY_SLACK && ct < r.end)
      return !range || range.end < ct + BUFFER_TARGET
    }

    // The range the playhead is playing out of, if there is one. It uses the
    // same slack as needsData() so that every caller agrees on which of several
    // ranges the element is actually reading from.
    const playheadRange = () => {
      const ct = videoElement.currentTime
      return getTimeRanges(sourceBuffer).find((r) => r.start <= ct + BOUNDARY_SLACK && ct < r.end)
    }

    // The furthest point any append has reached. The end of the stream may only
    // be signalled once the playhead's own range covers it: a hole left behind
    // by a tight evict would otherwise end the stream at the near range and cut
    // mediaSource.duration down to it, collapsing the movie to a minute.
    const atEnd = () => {
      const range = playheadRange()
      return !!range && range.end >= lastAppendedEnd - 0.1
    }
    const trackAppendedEnd = () => {
      const ends = getTimeRanges(sourceBuffer).map((r) => r.end)
      if (ends.length) lastAppendedEnd = Math.max(lastAppendedEnd, ...ends)
    }

    // Moves the remuxer to `time` and restarts the append stream there. Reads
    // run strictly forward from wherever the remuxer sits, so this is the only
    // way anything but the next contiguous segment ever gets appended.
    const seekTo = async (time: number) => {
      seeking = true
      // Anything read before the seek belongs to the old output timeline.
      pending = null
      pendingAttempts = 0
      const generation = ++seekGeneration
      try {
        const { data, pts, subtitles: fragments } = await remuxer.seek(time)
        if (destroyed || generation !== seekGeneration) return
        if (fragments?.length) subtitles.pushFragments(fragments)
        // The remuxer restarts its fragment timeline on every seek and this pts
        // is what re-bases it, so a superseded seek must not apply a stale one.
        await updateTimestampOffset(pts)
        if (destroyed || generation !== seekGeneration) return
        if (data.byteLength) {
          await appendBuffer(data)
          trackAppendedEnd()
        }
      } catch (error) {
        reportError(error, destroyed || generation !== seekGeneration)
      } finally {
        if (generation === seekGeneration) seeking = false
      }
    }

    // The remuxer cannot hand the same bytes back, so a refused append would
    // leave a permanent hole; keep the segment and offer it again next tick.
    // A refusal for want of room is the exception, and is handled by moving the
    // stream instead of by retrying.
    const flushPending = async () => {
      const segment = pending
      if (!segment) return
      try {
        await appendBuffer(segment)
        trackAppendedEnd()
        if (pending === segment) {
          pending = null
          pendingAttempts = 0
        }
      } catch (error) {
        if (pending !== segment) return
        // Chrome refuses appends past a per-element video budget of roughly
        // 150MB, which high-bitrate content reaches inside the normal window.
        if ((error as DOMException)?.name === 'QuotaExceededError') {
          const evicted = await evict(true).then(() => true, () => false)
          if (pending !== segment) return
          if (evicted) {
            // The refused segment sits at the buffered end the tight evict just
            // threw away, so offering it again would land it past a hole that
            // nothing can ever fill: reads only move forward and the element
            // only jumps gaps of about a second. Drop it and restart the stream
            // at the end of what was kept, which costs one re-read of those
            // bytes and keeps the buffer in one piece. The seek generation this
            // bumps is also what makes the read now in flight discard itself.
            //
            // Seeking to the playhead instead would re-append the seconds the
            // evict just paid to keep and can walk straight back into the same
            // refusal, so resume at the far edge of the window rather than its
            // near one. If the evict left no range around the playhead there is
            // nothing to continue, and starting over at the playhead is safe.
            //
            // The read that produced this segment may have been the last one,
            // and the stream is no longer finished once it has been moved back
            // into the middle of the file.
            finished = false
            await seekTo(playheadRange()?.end ?? videoElement.currentTime)
            return
          }
        }
        pendingAttempts += 1
        if (pendingAttempts < MAX_APPEND_ATTEMPTS) return
        // A segment that still will not go in is reported rather than held for
        // ever, and dropping it lets the pump move on to the next one.
        pending = null
        throw error
      }
    }

    const pump = async () => {
      if (reading || seeking || destroyed) return
      if (!pending && (finished || !needsData())) return
      const generation = ++readGeneration
      const seekAtStart = seekGeneration
      const stale = () => destroyed || generation !== readGeneration || seekAtStart !== seekGeneration
      reading = true
      try {
        if (!pending) {
          const { data, subtitles: fragments, finished: done } = await remuxer.read()
          if (stale()) return
          if (done) finished = true
          if (fragments?.length) subtitles.pushFragments(fragments)
          if (!data.byteLength) return
          pending = data
          pendingAttempts = 0
        }
        await flushPending()
        // A read that failed once and went through on the next tick leaves its
        // message sitting over a healthy video: a gap of a few seconds inside a
        // 30s buffer never stalls the element, so 'playing' never fires again
        // and the only other retraction path never runs.
        if (!stale() && outstandingError) {
          outstandingError = false
          onRecovered?.()
        }
      } catch (error) {
        reportError(error, stale())
      } finally {
        if (generation === readGeneration) reading = false
      }
    }

    const onSeeking = () => {
      finished = false
      const duration = metadata.info.input.duration || videoElement.duration
      if (duration > 0) onSeek?.(Math.min(Math.max(videoElement.currentTime / duration, 0), 1))
      // The listener is only the trigger, so it does not wait on the seek it
      // starts: everything after this point is guarded by the generation token.
      void seekTo(videoElement.currentTime)
    }
    videoElement.addEventListener('seeking', onSeeking)
    teardown.push(() => videoElement.removeEventListener('seeking', onSeeking))

    const interval = setInterval(() => {
      evict().catch(() => {})
      pump().catch((error) => reportError(error, false))
      // Every remove() puts the MediaSource back to 'open', and evict() runs one
      // on nearly every tick, so the end of the stream is re-armed rather than
      // signalled once. Without it the last frame sits under a spinner and the
      // element never fires 'ended'.
      if (finished && !pending && atEnd() && mediaSource.readyState === 'open') endOfStream().catch(() => {})
    }, 100)
    teardown.push(() => clearInterval(interval))

    return {
      destroy: runTeardown,
      selectSubtitleStream: (streamIndex: number) => subtitles.selectStream(streamIndex),
    }
  } catch (error) {
    runTeardown()
    throw error
  }
}
