import type { ReactNode } from 'react'
import type { AudioStream, PlaybackController } from '../player/playback'
import type { SubtitleStream } from '../player/subtitles'

import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'
import { Menu } from '@videojs/react'
import { CaptionsOnIcon, CheckIcon, VolumeHighIcon } from '@videojs/react/icons'

import { getHumanReadableByteString } from '../utils/bytes'
import { downloadedFractions } from '../torrent/downloaded-ranges'
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

const trackLabel = (t: { title: string, language: string, streamIndex: number }) =>
  t.title || t.language || `Track ${t.streamIndex}`

type TrackMenuProps = {
  label: string
  icon: ReactNode
  options: { value: string, label: string }[]
  value: string
  onSelect: (value: string) => void
}

const TrackMenu = ({ label, icon, options, value, onSelect }: TrackMenuProps) => (
  <Menu.Root side="bottom" align="end">
    <Menu.Trigger className="media-button media-button--subtle media-button--icon" aria-label={label}>
      {icon}
    </Menu.Trigger>
    <Menu.Content className="media-surface media-popover media-menu">
      <Menu.RadioGroup className="media-menu__group" label={label} value={value} onValueChange={onSelect}>
        {options.map((option) => (
          <Menu.RadioItem key={option.value} className="media-menu__item" value={option.value}>
            <span>{option.label}</span>
            <Menu.ItemIndicator checked={option.value === value} forceMount className="media-menu__indicator">
              <CheckIcon className="media-icon"/>
            </Menu.ItemIndicator>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Content>
  </Menu.Root>
)

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => (_magnet ? atob(_magnet) : undefined), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const { snapshot, read, prioritizeFrom } = usePlayerTorrent(magnet, fileIndex)

  const controllerRef = useRef<PlaybackController | null>(null)
  const [subtitleStreams, setSubtitleStreams] = useState<SubtitleStream[]>([])
  // undefined = the renderer's auto-pick (first stream); -1 = off.
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | undefined>(undefined)
  const subtitleValue = selectedSubtitle ?? subtitleStreams[0]?.streamIndex ?? -1
  const onSelectSubtitle = (streamIndex: number) => {
    setSelectedSubtitle(streamIndex)
    controllerRef.current?.selectSubtitleStream(streamIndex)
  }

  const [audioStreams, setAudioStreams] = useState<AudioStream[]>([])
  // undefined = the remuxer's pick (first stream); a number restarts playback on it.
  const [selectedAudio, setSelectedAudio] = useState<number | undefined>(undefined)
  const [effectiveAudio, setEffectiveAudio] = useState(-1)
  const audioValue = selectedAudio ?? effectiveAudio

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
  const downloadedRanges = useMemo(() => downloadedFractions(snapshot, fileIndex), [snapshot, fileIndex])

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
        {audioStreams.length > 1 && (
          <TrackMenu
            label="Audio"
            icon={<VolumeHighIcon className="media-icon"/>}
            options={audioStreams.map((s) => ({ value: String(s.streamIndex), label: trackLabel(s) }))}
            value={String(audioValue)}
            onSelect={(v) => setSelectedAudio(Number(v))}
          />
        )}
        {subtitleStreams.length > 0 && (
          <TrackMenu
            label="Subtitles"
            icon={<CaptionsOnIcon className="media-icon"/>}
            options={[
              ...subtitleStreams.map((s) => ({ value: String(s.streamIndex), label: trackLabel(s) })),
              { value: '-1', label: 'Off' },
            ]}
            value={String(subtitleValue)}
            onSelect={(v) => onSelectSubtitle(Number(v))}
          />
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
        downloadedRanges={downloadedRanges}
        onSeek={(fraction) => { if (fileSize) prioritizeFrom(fraction * fileSize) }}
        audioStreamIndex={selectedAudio}
        onSubtitleStreams={setSubtitleStreams}
        onAudioStreams={(streams, selected) => { setAudioStreams(streams); setEffectiveAudio(selected) }}
        onController={(controller) => {
          controllerRef.current = controller
          // An audio switch rebuilds the pipeline; re-apply the subtitle choice.
          if (controller && selectedSubtitle !== undefined) controller.selectSubtitleStream(selectedSubtitle)
        }}
      />
    </div>
  )
}

export default Player
