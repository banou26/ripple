import type { RxDocument } from 'rxdb'

import { readTorrentFile, torrentCollection, type TorrentDocument } from '../database'

import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'

import FKNMediaPlayer from '@banou/media-player'

import { useParams } from 'react-router'
import { getRoutePath, Route } from './path'
import { ArrowLeft, Home } from 'react-feather'
import { Link } from 'react-router-dom'
import { torrent } from '@fkn/lib'
import { Subscription } from 'rxjs'

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

const BASE_BUFFER_SIZE = 5_000_000

const getFileMatchingDownloadedRange = (file: RxDocument<NonNullable<TorrentDocument['state']['files']>[number]>, offset: number, end: number) =>
  file
    ?.downloadedRanges
    .filter((range) => range.start <= offset && end <= range.end)

const Watch = () => {
  const { infoHash, fileIndex } = useParams<{ infoHash: string }>()
  const [size, setSize] = useState<number>()

  const [torrentDoc, setTorrent] = useState<RxDocument<TorrentDocument>>()
  useEffect(() => {
    const subscription =
      torrentCollection
        ?.findOne({ selector: { infoHash } })
        .$
        .subscribe((result) => setTorrent(result ?? undefined))
    return () => subscription?.unsubscribe()
  }, [])

  const file = torrentDoc?.state?.files?.[fileIndex]
  const fileRef = useRef(file)

  useEffect(() => {
    if (!file) return
    
    const sub = torrentDoc.$.subscribe((torrentDoc) => {
      const file = torrentDoc.state.files?.[fileIndex]
      fileRef.current = file
    })

    return () => sub.unsubscribe()
  }, [Boolean(file)])

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

  const onFetch = async (offset: number, end: number) => {
    const file = fileRef.current
    const matchingRanges = getFileMatchingDownloadedRange(file, offset, end)

    if (matchingRanges?.length) {
      const res = await readTorrentFile({ infoHash, filePath: file.path, offset, size: end - offset + 1 })
      return new Response(res)
    } else {
      if (offset >= file?.length - 1_000_000) {
        const res = await torrent({
          magnet: torrentDoc.state.magnet,
          path: file.path,
          offset,
          end: file?.length
        })
        return new Response(await res.arrayBuffer())
      }

      await new Promise((resolve) => setTimeout(resolve, 250))
      return onFetch(offset, end)
    }
  }

  const customOverlay = useMemo(() => (
    <div className="player-overlay">
      <Link to={getRoutePath(Route.HOME)} className="home">
        <Home/>
        <span>Back</span>
      </Link>
    </div>
  ), [])

  return (
    <div css={playerStyle}>
      <FKNMediaPlayer
        size={size}
        fetch={(offset, end) => onFetch(offset, end)}
        publicPath={new URL(import.meta.env.DEV ? '/build/' : '/', new URL(window.location.toString()).origin).toString()}
        libavWorkerUrl={libavWorkerUrl}
        libassWorkerUrl={jassubWorkerUrl}
        wasmUrl={new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`, new URL(window.location.toString()).origin).toString()}
        customOverlay={customOverlay}
      />
    </div>
  )
}

export default Watch
