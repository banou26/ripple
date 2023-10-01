import { css } from '@emotion/react'
import { useDropzone } from 'react-dropzone'
import { useCallback, useEffect } from 'react'
import { Buffer } from 'buffer'
import parseTorrent, { Instance } from 'parse-torrent'

import { addTorrent } from '../torrent/collection'

export const style = css`
  position: relative;
  
  :after {
    content: "You can now drop your torrent files";
    position: absolute;
    display: flex;
    inset: 1rem;
    bottom: 3.5rem;
    align-items: center;
    justify-content: center;
    background-color: rgba(0,0,0,.1);
    border: 2px dashed #fff;
    border-color: var(--pink);
    border-radius: 10px;
    opacity: 0;
    transform: scale(.95);
    transition: all .2s ease-in;
    transition-property: transform,opacity;
    pointer-events: none;

    background-color: rgba(0, 0, 0, 0.4);
    border-color: var(--darkreader-border--pink);
  }

  &.active:after {
    opacity: 1;
    transform: scale(1);
    transition-timing-function: ease-out;
  }
`

const DropZone = ({ children, ...rest }) => {
  const onAddTorrent = useCallback(async (acceptedFiles: File[], magnet?: string) => {
    const parsedTorrents = await Promise.all(
      [
        ...await Promise.all(acceptedFiles.map(file => {
          const reader = new FileReader()
          return new Promise<Buffer>((resolve, reject) => {
            reader.onload = () => {
              if (!reader.result || !(reader.result instanceof ArrayBuffer)) return
              resolve(Buffer.from(reader.result))
            }
            reader.onerror = reject
            reader.readAsArrayBuffer(file)
          })
        })),
        ...magnet ? [magnet] : []
      ].map(parseTorrent)
    ) as Instance[]

    parsedTorrents.forEach(torrent => {
      console.log('torrent', torrent)
      addTorrent({
        infoHash: torrent.infoHash,
        state: {
          name: torrent.name,
          magnet: magnet,
          torrentFile: torrent
        }
      })
    })
    console.log('parsedTorrents', parsedTorrents)
  }, [])
  const {getRootProps, getInputProps, isDragActive} = useDropzone({
    onDrop: files => onAddTorrent(files, undefined),
    noClick: true
  })

  useEffect(() => {
    const listener = (event: ClipboardEvent) =>
      onAddTorrent(
        [...event.clipboardData?.files ?? []],
        event.clipboardData?.getData('Text')
      )
    addEventListener('paste', listener)
    return () => removeEventListener('paste', listener)
  }, [])

  return (
    <div css={style} {...getRootProps()} className={`drag-zone ${isDragActive ? 'active' : ''}`}>
      <input {...getInputProps()} />
      {children}
    </div>
  )
}

export default DropZone
