import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'

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

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => (_magnet ? atob(_magnet) : undefined), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const { snapshot, read } = usePlayerTorrent(magnet, fileIndex)

  const selectedFile = snapshot?.files?.files[fileIndex]
  const fileSize = selectedFile?.size

  const origin = useMemo(() => new URL(window.location.toString()).origin, [])
  const publicPath = useMemo(() => new URL(import.meta.env.DEV ? '/build/' : '/', origin).toString(), [origin])

  // libav loads as an ES module worker (its emscripten glue uses import.meta).
  const libavWorkerUrl = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/libav-worker.js`, origin).toString(),
    [origin]
  )

  // jassub's prebuilt worker is a classic script — wrap it via importScripts.
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
      />
    </div>
  )
}

export default Player
