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
  audioStreamIndex?: number
  onSubtitleStreams?: (streams: SubtitleStream[]) => void
  onAudioStreams?: (streams: AudioStream[], selected: number) => void
  onController?: (controller: PlaybackController | null) => void
}

export const VideoJsPlayer = ({
  read, size, publicPath, libavWorkerUrl, jassubWorkerUrl, jassubWasmUrl,
  defaultFontUrl, autoplay = true, overlay, audioStreamIndex,
  onSubtitleStreams, onAudioStreams, onController,
}: VideoJsPlayerProps) => {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const onSubtitleStreamsRef = useRef(onSubtitleStreams)
  onSubtitleStreamsRef.current = onSubtitleStreams
  const onAudioStreamsRef = useRef(onAudioStreams)
  onAudioStreamsRef.current = onAudioStreams
  const onControllerRef = useRef(onController)
  onControllerRef.current = onController
  // Changing the audio track restarts the whole pipeline; carry the position over.
  const resumeTimeRef = useRef(0)

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
    <div css={playerStyle}>
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
