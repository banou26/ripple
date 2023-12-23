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

const BACKPRESSURE_STREAM_ENABLED = !navigator.userAgent.includes("Firefox")
const BASE_BUFFER_SIZE = 5_000_000

export const bufferStream = ({ stream, size: SIZE }: { stream: ReadableStream, size: number }) =>
  new ReadableStream<Uint8Array>({
    start() {
      this.cancelled = false
      // @ts-expect-error
      this.reader = stream.getReader()
    },
    async pull(controller) {
      try {
        // @ts-expect-error
        const { leftOverData }: { leftOverData: Uint8Array | undefined } = this

        const accumulate = async ({ buffer = new Uint8Array(SIZE), currentSize = 0 } = {}): Promise<{ buffer?: Uint8Array, currentSize?: number, done: boolean }> => {
          // @ts-expect-error
          const { value: newBuffer, done } = await this.reader.read()

          if (currentSize === 0 && leftOverData) {
            buffer.set(leftOverData)
            currentSize += leftOverData.byteLength
            // @ts-expect-error
            this.leftOverData = undefined
          }
    
          if (done) {
            return { buffer: buffer.slice(0, currentSize), currentSize, done }
          }
    
          let newSize
          const slicedBuffer = newBuffer.slice(0, SIZE - currentSize)
          newSize = currentSize + slicedBuffer.byteLength
          buffer.set(slicedBuffer, currentSize)
    
          if (newSize === SIZE) {
            // @ts-expect-error
            this.leftOverData = newBuffer.slice(SIZE - currentSize)
            return { buffer, currentSize: newSize, done: false }
          }
          
          return accumulate({ buffer, currentSize: newSize })
        }
        const { buffer, done } = await accumulate()
        if (this.cancelled) return
        if (buffer?.byteLength) controller.enqueue(buffer)
        if (done) controller.close()
      } catch (err) {
        console.error(err)
      }
    },
    cancel() {
      // @ts-expect-error
      this.reader.cancel()
      this.cancelled = true
    }
  })

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => _magnet && atob(_magnet), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])

  const [file, setFile] = useState<Exclude<ParseTorrent.Instance['files'], undefined>[number]>()
  const [size, setSize] = useState<number>()

  const [currentStreamOffset, setCurrentStreamOffset] = useState<number>(0)
  const [streamReader, setStreamReader] = useState<ReadableStreamDefaultReader<Uint8Array>>()

  useEffect(() => {
    if (!streamReader) return
    return () => void streamReader.cancel()
  }, [streamReader])

  const onFetch = async (offset: number, end?: number, force?: boolean) => {
    if (offset >= file!.length - 1_000_000) {
      const res = await torrent({
        magnet: magnet!,
        path: file!.path,
        offset,
        end: file?.length
      })
      return new Response(await res.arrayBuffer())
    }
    if (force || end !== undefined && ((end - offset) + 1) !== BASE_BUFFER_SIZE) {
      return torrent({
        magnet: magnet!,
        path: file!.path,
        offset,
        end
      })
    }
    const _streamReader =
      !streamReader || currentStreamOffset !== offset
        ? await setupStream(offset)
        : streamReader

    if (!_streamReader) throw new Error('Stream reader not ready')
    return new Response(
      await _streamReader
        .read()
        .then(({ value }) => {
          if (value) {
            setCurrentStreamOffset(offset => offset + value.byteLength)
          }
          return value
        })
    )
  }

  const setupStream = async (offset: number) => {
    if (streamReader) {
      streamReader.cancel()
    }
    const streamResponse = await onFetch(offset, undefined, true)
    if (!streamResponse.body) throw new Error('no body')
    const stream = bufferStream({ stream: streamResponse.body, size: BASE_BUFFER_SIZE })
    const reader = stream.getReader()
    setStreamReader(reader)
    setCurrentStreamOffset(offset)
    return reader
  }

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
    if (BACKPRESSURE_STREAM_ENABLED) setupStream(0)
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
