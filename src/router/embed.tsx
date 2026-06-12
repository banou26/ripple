import type { PlaybackController } from '../player/playback'
import type { SubtitleStream } from '../player/subtitles'

import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'
import { Menu } from '@videojs/react'
import { CaptionsOnIcon, CheckIcon } from '@videojs/react/icons'

import { getHumanReadableByteString } from '../utils/bytes'
import { usePlayerTorrent } from '../torrent/use-player-torrent'
import { TooltipDisplay } from '../components/tooltip-display'
import { VideoJsPlayer } from '../player/videojs-player'

const playerStyle = css`
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: #000;

  .ripple-overlay-content {
    display: flex;
    justify-content: space-between;
    align-items: start;
    padding: 1.5rem;
  }

  .media-information {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    font-weight: 400;
    font-size: 1.2rem;
    line-height: 1.7rem;
    @media (min-width: 960px) {
      font-size: 1.4rem;
      line-height: 2rem;
    }
    text-shadow: 0 0 4px rgba(0, 0, 0, 1);
    color: #fff;

    .item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
  }

  .loading-information {
    color: #fff;
    font-size: 1.3rem;
    text-shadow: 0 0 4px rgba(0, 0, 0, 1);
    padding: 8px 12px;
  }
`

type SubtitleMenuProps = {
  streams: SubtitleStream[]
  value: number
  onSelect: (streamIndex: number) => void
}

const SubtitleMenu = ({ streams, value, onSelect }: SubtitleMenuProps) => {
  const options = [
    ...streams.map((s) => ({ value: String(s.streamIndex), label: s.title || s.language || `Track ${s.streamIndex}` })),
    { value: '-1', label: 'Off' },
  ]
  return (
    <Menu.Root side="bottom" align="end">
      <Menu.Trigger className="media-button media-button--subtle media-button--icon" aria-label="Subtitles">
        <CaptionsOnIcon className="media-icon"/>
      </Menu.Trigger>
      <Menu.Content className="media-surface media-popover media-menu">
        <Menu.RadioGroup
          className="media-menu__group"
          label="Subtitles"
          value={String(value)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          {options.map((option) => (
            <Menu.RadioItem key={option.value} className="media-menu__item" value={option.value}>
              <span>{option.label}</span>
              <Menu.ItemIndicator checked={option.value === String(value)} forceMount className="media-menu__indicator">
                <CheckIcon className="media-icon"/>
              </Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  )
}

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => (_magnet ? atob(_magnet) : undefined), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const { snapshot, read } = usePlayerTorrent(magnet, fileIndex)

  const controllerRef = useRef<PlaybackController | null>(null)
  const [subtitleStreams, setSubtitleStreams] = useState<SubtitleStream[]>([])
  // undefined = the renderer's auto-pick (first stream); -1 = off.
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | undefined>(undefined)
  const subtitleValue = selectedSubtitle ?? subtitleStreams[0]?.streamIndex ?? -1
  const onSelectSubtitle = (streamIndex: number) => {
    setSelectedSubtitle(streamIndex)
    controllerRef.current?.selectSubtitleStream(streamIndex)
  }

  const selectedFile = snapshot?.files?.files[fileIndex]
  const fileSize = selectedFile?.size

  const origin = useMemo(() => new URL(window.location.toString()).origin, [])
  const publicPath = useMemo(() => new URL(import.meta.env.DEV ? '/build/' : '/', origin).toString(), [origin])

  // libav loads as an ES module worker (its emscripten glue uses import.meta).
  const libavWorkerUrl = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/libav-worker.js`, origin).toString(),
    [origin]
  )

  // jassub's prebuilt worker is a classic script - wrap it via importScripts.
  const jassubWorkerUrl = useMemo(() => {
    const url = new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker.js`, origin).toString()
    return URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(url)})`], { type: 'application/javascript' }))
  }, [origin])

  const jassubWasmUrl = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`, origin).toString(),
    [origin]
  )

  const defaultFontUrl = useMemo(() => new URL(`${publicPath}default.woff2`).toString(), [publicPath])

  const [info, setInfo] = useState({ peers: 0, downloadSpeed: 0, uploadSpeed: 0 })
  useEffect(() => {
    const st = snapshot?.status
    setInfo({ peers: st?.numPeers ?? 0, downloadSpeed: st?.downloadRate ?? 0, uploadSpeed: st?.uploadRate ?? 0 })
  }, [snapshot?.status])

  const hasMetadata = Boolean(snapshot?.files)
  const downloaded = snapshot?.status?.totalDone ?? 0

  const overlay = (
    <div className="ripple-overlay-content">
      <div className="loading-information">
        {!hasMetadata
          ? 'Loading metadata…'
          : `Downloaded ${getHumanReadableByteString(downloaded)}`}
      </div>
      <div className="media-information">
        <TooltipDisplay
          id="peers"
          text={<div className="item"><User /><span>{info.peers}</span></div>}
          toolTipText={<span>Peers: {info.peers}<br />Computers connected to you</span>}
        />
        <TooltipDisplay
          id="download-speed"
          text={<div className="item"><ArrowDown /><span>{getHumanReadableByteString(info.downloadSpeed, true)}/s</span></div>}
          toolTipText={<span>Download speed: {getHumanReadableByteString(info.downloadSpeed)}/s</span>}
        />
        <TooltipDisplay
          id="upload-speed"
          text={<div className="item"><ArrowUp /><span>{getHumanReadableByteString(info.uploadSpeed, true)}/s</span></div>}
          toolTipText={<span>Upload speed: {getHumanReadableByteString(info.uploadSpeed)}/s</span>}
        />
        {subtitleStreams.length > 0 && (
          <SubtitleMenu streams={subtitleStreams} value={subtitleValue} onSelect={onSelectSubtitle}/>
        )}
      </div>
    </div>
  )

  return (
    <div css={playerStyle}>
      <VideoJsPlayer
        read={read}
        size={fileSize}
        publicPath={publicPath}
        libavWorkerUrl={libavWorkerUrl}
        jassubWorkerUrl={jassubWorkerUrl}
        jassubWasmUrl={jassubWasmUrl}
        defaultFontUrl={defaultFontUrl}
        autoplay={true}
        overlay={overlay}
        onSubtitleStreams={setSubtitleStreams}
        onController={(controller) => { controllerRef.current = controller }}
      />
    </div>
  )
}

export default Player
