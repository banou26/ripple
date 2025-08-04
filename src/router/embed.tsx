import type { DownloadedRange } from '@banou/media-player/src/utils/context'

import { useContext, useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'

import MediaPlayer from '@banou/media-player'

import { nodeToWebReadable } from '../utils/stream'
import { getBytesRangesFromBitfield } from '../utils/downloaded-ranges'
import { getHumanReadableByteString } from '../utils/bytes'
import { useTorrent, WebTorrentContext } from '../utils/torrent'
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
  const magnet = useMemo(() => _magnet && atob(_magnet), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const webtorrent = useContext(WebTorrentContext)
  const torrent = useTorrent({ webtorrent, fileIndex, magnet })

  const selectedFile = torrent?.files?.[fileIndex]
  const fileSize = torrent?.ready ? selectedFile?.length : undefined

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

  const read = (offset: number, size: number) => {
    if (!selectedFile) throw new Error('selectedFile is undefined')
    const readable = selectedFile.createReadStream({ start: offset, end: offset + size - 1 })
    const readableStream = nodeToWebReadable(readable)
    return new Response(readableStream).arrayBuffer()
  }

  const [downloadedRanges, setDownloadedRanges] = useState<DownloadedRange[]>([])
  
  useEffect(() => {
    if (!torrent || !selectedFile) return
    const updateRanges = () => {
      setDownloadedRanges(
        getBytesRangesFromBitfield(
          torrent.bitfield, 
          torrent.pieceLength, 
          torrent.length,
          selectedFile.offset,
          selectedFile.length
        )
      )
    }
    const interval = setInterval(() => updateRanges(), 1000)
    updateRanges()
    return () => clearInterval(interval)
  }, [torrent, selectedFile])

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
    if (!torrent) return
    const updateMediaInformation = () => {
      setMediaInformationData({
        peers: torrent.numPeers,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed
      })
    }
    const interval = setInterval(() => updateMediaInformation(), 1000)
    updateMediaInformation()
    return () => clearInterval(interval)
  }, [torrent])

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
    if (!torrent) return
    const updateLoadingInformation = () => {
      setLoadingInformationData({
        hasMetadata: Boolean(torrent.metadata),
        ready: torrent.ready,
        downloaded: torrent.downloaded
      })
    }
    const interval = setInterval(() => updateLoadingInformation(), 100)
    updateLoadingInformation()
    return () => clearInterval(interval)
  }, [torrent])

  return (
    <div css={playerStyle}>
      <MediaPlayer
        title={selectedFile?.name}
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
