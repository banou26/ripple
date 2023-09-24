import { css } from '@emotion/react'
import { useDropzone } from 'react-dropzone'
import { useCallback, useEffect } from 'react'
import { Buffer } from 'buffer'
import parseTorrent from 'parse-torrent'

const style = css`
display: flex;
align-items: center;
justify-content: center;

.drag-zone {
  display: flex;

  transition: all 0.2s ease-in-out;

  background-color: #0f0f0f;
  border: 2px dashed #555;
  padding: 2rem;
  border-radius: 1rem;

  cursor: pointer;

  font-size: 2rem;

  &:hover {
    border-color: #aaa;
  }
  &:active {
    border-color: #fff;
  }

  p {
    color: #fff;
    text-align: center;
    margin: 0;
    
    &:last-child {
      margin-top: 1rem;
    }
  }
}
`

const DragDrop = () => {
  const onAddTorrent = useCallback(async (acceptedFiles: File[], magnet?: string) => {
    const parsedTorrents = await Promise.all(
      [
        ...await Promise.all(acceptedFiles.map(file => {
          const reader = new FileReader()
          return new Promise<parseTorrent.Instance>((resolve, reject) => {
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
    )
    console.log('parsedTorrents', parsedTorrents)
  }, [])
  const {getRootProps, getInputProps, isDragActive} = useDropzone({ onDrop: files => onAddTorrent(files, undefined) })

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
    <div {...getRootProps()} className="drag-zone">
      <input {...getInputProps()} />
      {
        isDragActive ? <p>Drop the files here ...</p>
        : (
          <div>
            <p>Drag and drop or click to select some torrents</p>
            <p>You can also paste magnets & torrent files</p>
          </div>
        )
      }
    </div>
  )
}



export const TorrentList = ({ ...rest }) => {

  return (
    <div css={style} {...rest}>
      <DragDrop/>
    </div>
  )
}

export default TorrentList

