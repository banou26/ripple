import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import ParseTorrent from 'parse-torrent'
import { Readable } from 'stream'

import FKNMediaPlayer from '@banou/media-player'

import type WebTorrentType from 'webtorrent'
import _WebTorrent from 'webtorrent/dist/webtorrent.min.js'

const WebTorrent = _WebTorrent as typeof WebTorrentType

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

const client = new WebTorrent({ utp: false })

const BASE_BUFFER_SIZE = 2_500_000

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => _magnet && atob(_magnet), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])

  const [file, setFile] = useState<Exclude<ParseTorrent.Instance['files'], undefined>[number]>()
  const [size, setSize] = useState<number>()
  const [webtorrentInstance, setWebtorrentInstance] = useState<WebTorrentType.Torrent>()

  const onFetch = (offset: number, end?: number) =>
    webtorrentInstance
      ?.files
      ?.[fileIndex]
      ?.createReadStream({ start: offset, end: end ?? size! })

  useEffect(() => {
    if (!magnet) return
    const torrent = client.add(magnet, {  }, (torrent) => {
      const file = torrent.files[fileIndex]
      if (!file) throw new Error(`No file found with index ${fileIndex}`)
      setInterval(() => {
        console.log(`progress ${torrent.progress * 100}% | DOWN ${torrent.downloadSpeed} | UP ${torrent.uploadSpeed} | PEERS ${torrent.numPeers}`)
      }, 10_000)
    })
    torrent.on('ready', () => {
      console.log('torrent ready', torrent)
      const file = torrent.files?.[fileIndex]
      if (!file) throw new Error(`No file found with index ${fileIndex}`)
      setFile(file)
      setWebtorrentInstance(torrent)
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
      {
        <FKNMediaPlayer
          size={
            webtorrentInstance?.files?.[fileIndex]
              ? size
              : undefined
          }
          baseBufferSize={BASE_BUFFER_SIZE}
          fetch={async (offset, end) => new Response(nodeToWebReadable(onFetch(offset, end)))}
          publicPath={new URL(import.meta.env.DEV ? '/build/' : '/', new URL(window.location.toString()).origin).toString()}
          libavWorkerUrl={libavWorkerUrl}
          libassWorkerUrl={jassubWorkerUrl}
          wasmUrl={new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`, new URL(window.location.toString()).origin).toString()}
        />
      }
    </div>
  )
}

const nodeToWebReadable = (stream: Readable) => {
  const iterator = stream[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel() {
      stream.destroy()
    }
  })
}

export default Player
