import type { ReactNode } from 'react'
import type { Media } from '@videojs/core/dom'

import { useEffect, useRef, useState } from 'react'
import { css, Global } from '@emotion/react'
import { videoFeatures } from '@videojs/core/dom'
import { createPlayer, useMediaAttach } from '@videojs/react'
import { VideoSkin } from '@videojs/react/video'
import skinCss from '@videojs/react/video/skin.css?inline'

import { startPlayback } from './playback'
import type { AudioStream, PlaybackController } from './playback'
import type { SubtitleStream } from './subtitles'

const player = createPlayer({ features: videoFeatures, displayName: 'RipplePlayer' })

const playerStyle = css`
  position: fixed;
  inset: 0;
  height: 100vh;
  width: 100vw;
  background: #000;

  .media-default-skin {
    height: 100%;
    width: 100%;
  }
  .media-default-skin video {
    height: 100%;
    width: 100%;
    object-fit: contain;
  }
  .ripple-subtitle-canvas {
    position: absolute;
    inset: 0;
    height: 100%;
    width: 100%;
    pointer-events: none;
    z-index: 1;
  }
  .ripple-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }
  /* The torrent's downloaded regions replace the MSE buffer bar: playback
     evicts the SourceBuffer to a ~80s window, so video.buffered is always a
     sliver of what is actually seekable from disk. */
  .media-slider__buffer {
    display: none;
  }
  .ripple-downloaded {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .ripple-downloaded div {
    position: absolute;
    top: 0;
    height: 100%;
    background-color: oklch(from currentColor l c h / 0.2);
  }
`

// The video.js skin sizes its controls in rem; ripple's global
// html{font-size:62.5%} would render them at ⅝ scale, so restore a 16px
// root while the full-page player is mounted. The video is object-fit, so
// font-size doesn't affect it - only the skin's rem-based chrome.
const playerRoot = css`
  html {
    font-size: 100%;
  }
`

// Pushes the real <video> element into the video.js store - a plain
// HTMLVideoElement already satisfies the structural Media contract.
const MediaAttach = ({ video }: { video: HTMLVideoElement | null }) => {
  const setMedia = useMediaAttach()
  useEffect(() => {
    if (!setMedia || !video) return
    setMedia(video as unknown as Media)
    return () => { setMedia(null) }
  }, [video, setMedia])
  return null
}

export type VideoJsPlayerProps = {
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  size: number | undefined
  publicPath: string
  libavWorkerUrl: string
  jassubWorkerUrl: string
  jassubWasmUrl: string
  defaultFontUrl: string
  autoplay?: boolean
  overlay?: ReactNode
  // Downloaded regions of the file as [from, to] fractions, drawn on the
  // seekbar in place of the MSE-derived buffer bar.
  downloadedRanges?: [number, number][]
  audioStreamIndex?: number
  onSeek?: (fraction: number) => void
  onSubtitleStreams?: (streams: SubtitleStream[]) => void
  onAudioStreams?: (streams: AudioStream[], selected: number) => void
  onController?: (controller: PlaybackController | null) => void
}

export const VideoJsPlayer = ({
  read, size, publicPath, libavWorkerUrl, jassubWorkerUrl, jassubWasmUrl,
  defaultFontUrl, autoplay = true, overlay, downloadedRanges, audioStreamIndex,
  onSeek, onSubtitleStreams, onAudioStreams, onController,
}: VideoJsPlayerProps) => {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const readRef = useRef(read)
  readRef.current = read
  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek
  const onSubtitleStreamsRef = useRef(onSubtitleStreams)
  onSubtitleStreamsRef.current = onSubtitleStreams
  const onAudioStreamsRef = useRef(onAudioStreams)
  onAudioStreamsRef.current = onAudioStreams
  const onControllerRef = useRef(onController)
  onControllerRef.current = onController
  // Changing the audio track restarts the whole pipeline; carry the position over.
  const resumeTimeRef = useRef(0)

  // The skin is rendered wholesale, so the downloaded layer is painted into
  // its slider track by hand rather than composed as a React child.
  useEffect(() => {
    if (!downloadedRanges) return
    const track = rootRef.current?.querySelector('.media-slider__track')
    if (!track) return
    let layer = track.querySelector<HTMLElement>('.ripple-downloaded')
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'ripple-downloaded'
      track.prepend(layer)
    }
    while (layer.childElementCount > downloadedRanges.length) layer.lastElementChild!.remove()
    while (layer.childElementCount < downloadedRanges.length) layer.appendChild(document.createElement('div'))
    downloadedRanges.forEach(([from, to], i) => {
      const seg = layer.children[i] as HTMLElement
      seg.style.left = `${from * 100}%`
      seg.style.width = `${(to - from) * 100}%`
    })
  }, [downloadedRanges, video])

  useEffect(() => {
    if (!video || !canvas || !size) return
    let controller: PlaybackController | undefined
    let cancelled = false
    ;(async () => {
      try {
        const ctrl = await startPlayback({
          videoElement: video,
          canvasElement: canvas,
          read: (offset, length) => readRef.current(offset, length),
          length: size,
          publicPath,
          libavWorkerUrl,
          jassubWorkerUrl,
          jassubWasmUrl,
          defaultFontUrl,
          audioStreamIndex,
          onReady: () => {
            if (cancelled) return
            if (resumeTimeRef.current > 0) {
              video.currentTime = resumeTimeRef.current
              resumeTimeRef.current = 0
            }
            if (autoplay) video.play().catch(() => {})
          },
          onSeek: (fraction) => onSeekRef.current?.(fraction),
          onSubtitleStreams: (streams) => onSubtitleStreamsRef.current?.(streams),
          onAudioStreams: (streams, selected) => onAudioStreamsRef.current?.(streams, selected),
        })
        if (cancelled) ctrl.destroy()
        else {
          controller = ctrl
          onControllerRef.current?.(ctrl)
        }
      } catch (error) {
        console.error('playback failed', error)
      }
    })()
    return () => {
      cancelled = true
      resumeTimeRef.current = video.currentTime
      controller?.destroy()
      onControllerRef.current?.(null)
    }
  }, [video, canvas, size, publicPath, libavWorkerUrl, jassubWorkerUrl, jassubWasmUrl, defaultFontUrl, audioStreamIndex])

  return (
    <div css={playerStyle} ref={rootRef}>
      <Global styles={skinCss} />
      <Global styles={playerRoot} />
      <player.Provider>
        <MediaAttach video={video} />
        <VideoSkin>
          <video ref={setVideo} playsInline />
          <canvas ref={setCanvas} className="ripple-subtitle-canvas" />
          {overlay ? <div className="ripple-overlay">{overlay}</div> : null}
        </VideoSkin>
      </player.Provider>
    </div>
  )
}

export default VideoJsPlayer
