import { Buffer } from 'buffer'

import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import ParseTorrent from 'parse-torrent'

import FKNMediaPlayer from '@banou/media-player'
import { torrent, torrentFile } from '@fkn/lib'

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
`

const BASE_BUFFER_SIZE = 2_500_000
const BACKPRESSURE_STREAM_ENABLED = !navigator.userAgent.includes("Firefox")

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => _magnet && atob(_magnet), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])

  const [file, setFile] = useState<Exclude<ParseTorrent.Instance['files'], undefined>[number]>()
  const [size, setSize] = useState<number>()

  const onFetch = async (offset: number, end?: number) =>
    torrent({
      magnet: magnet!,
      path: file!.path,
      offset,
      end: end ?? (BACKPRESSURE_STREAM_ENABLED ? Math.min(offset + BASE_BUFFER_SIZE, size!) : undefined),
    })

  useEffect(() => {
    if (!magnet) return
    torrentFile({ magnet })
      .then(async (torrentFile) => {
        const buffer = await torrentFile.arrayBuffer()
        const torrentInstance = (await ParseTorrent(Buffer.from(buffer))) as ParseTorrent.Instance
        const file = torrentInstance.files?.[fileIndex]
        if (!file) throw new Error(`No file found with index ${fileIndex}`)
        setFile(file)
      })
  }, [magnet, fileIndex])

  useEffect(() => {
    if (!file) return
    setSize(file.length)
  }, [file])

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

  return (
    <div css={playerStyle}>
      <FKNMediaPlayer
        size={size}
        baseBufferSize={BASE_BUFFER_SIZE}
        fetch={(offset, end) => onFetch(offset, end)}
        publicPath={new URL(import.meta.env.DEV ? '/build/' : '/', new URL(window.location.toString()).origin).toString()}
        libavWorkerUrl={libavWorkerUrl}
        libassWorkerUrl={jassubWorkerUrl}
        wasmUrl={new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`, new URL(window.location.toString()).origin).toString()}
      />
    </div>
  )
}

export default Player
