import type { DownloadedRange } from '@banou/media-player/src/utils/context'

import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'

import MediaPlayer from '@banou/media-player'

import { getBytesRangesFromBitfield } from '../utils/downloaded-ranges'
import { getHumanReadableByteString } from '../utils/bytes'
import { usePlayerTorrent } from '../torrent/use-player-torrent'
import { TooltipDisplay } from '../components/tooltip-display'

const playerStyle = css`
height: 100%;
width: 100%;
overflow-x: hidden;
/* width: 100%; */
& > div {
  height: 100%;
  width: 100%;
  & > video, & > div {
    height: 100vh;
    max-height: 100%;
    width: 100vw;
    max-width: 100%;
  }
}

grid-column: 1;
grid-row: 1;

div canvas {
  margin: auto;
}

.player-overlay {
  display: flex;
  justify-content: space-between;
  align-items: start;
  grid-column: 1;
  grid-row: 1;
  & > div, & > a {
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 3rem;
    font-weight: bold;
    cursor: pointer;

    & > svg {
      margin-right: 1rem;
    }
    text-decoration: none;
    margin: 1.5rem;
    padding: 1rem;
    position: relative;
    /* background-color: rgb(35, 35, 35); */
    /* background: linear-gradient(0deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.1) calc(100% - 1rem), rgba(0,0,0,0) 100%); */
    background: radial-gradient(ellipse at center, rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.1) calc(100% - 1rem),rgba(0,0,0,0) 100%);
  }
}

.hide {
  .player-overlay {
    display: none;
  }
}

.media-information {
  display: flex;
  align-items: center;
  justify-content: space-between;

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

  margin-right: 8px;
  @media (min-width: 768px) {
    margin-right: 12px;
  }
  @media (min-width: 2560px) {
    margin-right: 16px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
}
`

const BASE_BUFFER_SIZE = 2_500_000

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => _magnet ? atob(_magnet) : undefined, [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const { snapshot, read } = usePlayerTorrent(magnet, fileIndex)

  const selectedFile = snapshot?.files?.files[fileIndex]
  const fileSize = selectedFile?.size

  const jassubWorkerUrl = useMemo(() => {
    const workerUrl = new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker.js`, new URL(window.location.toString()).origin).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl)})`], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }, [])

  const libavWorkerUrl = useMemo(() => {
    const workerUrl = new URL(`${import.meta.env.DEV ? '/build' : ''}/libav-worker.js`, new URL(window.location.toString()).origin).toString()
    const blob = new Blob([`importScripts(${JSON.stringify(workerUrl)})`], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }, [])

  const publicPath = useMemo(
    () =>
      new URL(
        import.meta.env.DEV ? '/build/' : '/',
        new URL(window.location.toString()).origin
      ).toString(),
    []
  )

  const jassubModernWasmUrl = useMemo(
    () =>
      new URL(
        `${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`,
        new URL(window.location.toString()).origin
      ).toString(),
    []
  )

  const jassubWasmUrl = useMemo(
    () =>
      new URL(
        `${import.meta.env.DEV ? '/build' : ''}/jassub-worker.wasm`,
        new URL(window.location.toString()).origin
      ).toString(),
    []
  )

  const [downloadedRanges, setDownloadedRanges] = useState<DownloadedRange[]>([])

  // The worker pushes a fresh snapshot (incl. the have-bitfield) every 500ms, so
  // this re-derives the file's downloaded ranges on each update — no polling.
  useEffect(() => {
    const bf = snapshot?.bitfield
    if (!bf || !selectedFile) return
    setDownloadedRanges(
      getBytesRangesFromBitfield(
        bf.pieces,
        bf.pieceLength,
        bf.length,
        selectedFile.offset,
        selectedFile.size
      )
    )
  }, [snapshot?.bitfield, selectedFile])

  const [mediaInformationData, setMediaInformationData] = useState<{peers: number, downloadSpeed: number, uploadSpeed: number } | undefined>()
  const mediaInformation = useMemo(() => {
    if (!mediaInformationData) return undefined
    return (
      <div className='media-information'>
        <TooltipDisplay
          id='peers'
          text={
            <div className='item'>
              <User />
              <span>{mediaInformationData.peers}</span>
            </div>
          }
          toolTipText={
            <span>
              Peers: {mediaInformationData.peers} <br />
              Number of computers<br />connected to you
            </span>
          }
        />
        <TooltipDisplay
          id='download-speed'
          text={
            <div className='item'>
              <ArrowDown />
              <span>{getHumanReadableByteString(mediaInformationData.downloadSpeed, true)}/s</span>
            </div>
          }
          toolTipText={
            <span>
              Download speed: {getHumanReadableByteString(mediaInformationData.downloadSpeed)}/s
            </span>
          }
        />
        <TooltipDisplay
          id='upload-speed'
          text={
            <div className='item'>
              <ArrowUp />
              <span>{getHumanReadableByteString(mediaInformationData.uploadSpeed, true)}/s</span>
            </div>
          }
          toolTipText={
            <span>
              Upload speed: {getHumanReadableByteString(mediaInformationData.uploadSpeed)}/s
            </span>
          }
        />
      </div>
    )
  }, [mediaInformationData])

  useEffect(() => {
    const st = snapshot?.status
    setMediaInformationData({
      peers: st?.numPeers ?? 0,
      downloadSpeed: st?.downloadRate ?? 0,
      uploadSpeed: st?.uploadRate ?? 0,
    })
  }, [snapshot?.status])

  const [loadingInformationData, setLoadingInformationData] = useState<{ hasMetadata: Boolean, ready: boolean, downloaded: number } | undefined>()

  const loadingInformation = useMemo(() => {
    if (!loadingInformationData) {
      return (
        <div>
          Cleaning up & preparing for the torrent
        </div>
      )
    }

    if (!loadingInformationData.hasMetadata) {
      return (
        <div>
          Loading metadata
        </div>
      )
    }

    return (
      <div>
        {
          !loadingInformationData.ready
            ? (
              <div>
                Checking downloaded data, verified: {getHumanReadableByteString(loadingInformationData.downloaded)}
              </div>
            )
            : (
              <div>
                Downloaded {getHumanReadableByteString(loadingInformationData.downloaded)}
              </div>
            )
        }
      </div>
    )
  }, [loadingInformationData])

  useEffect(() => {
    // files() is non-null only once metadata + storage are ready ⇒ streamable.
    const hasMetadata = Boolean(snapshot?.files)
    setLoadingInformationData({
      hasMetadata,
      ready: hasMetadata,
      downloaded: snapshot?.status?.totalDone ?? 0,
    })
  }, [snapshot?.files, snapshot?.status])

  return (
    <div css={playerStyle}>
      <MediaPlayer
        title={selectedFile?.path.split('/').pop()}
        bufferSize={BASE_BUFFER_SIZE}
        read={read}
        size={fileSize}
        downloadedRanges={downloadedRanges}
        autoplay={true}
        loadingInformation={loadingInformation}
        mediaInformation={mediaInformation}
        publicPath={publicPath}
        libavWorkerUrl={libavWorkerUrl}
        jassubWasmUrl={jassubWasmUrl}
        jassubWorkerUrl={jassubWorkerUrl}
        jassubModernWasmUrl={jassubModernWasmUrl}
      />
    </div>
  )
}

export default Player
