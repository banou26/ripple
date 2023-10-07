import { useEffect, useState } from 'react'
import { css } from '@emotion/react'
import { get, set } from 'idb-keyval'

import Modal from './modal'

const style = css`
  padding: 2rem;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 50rem;
  .content {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    & > h2 {
      font-size: 2rem;
      margin-bottom: 2rem;
    }
    p {
      font-size: 1.5rem;
      margin-bottom: 2rem;
      justify-content: center;
      text-align: center;
    }
    button {
      font-size: 1.5rem;
      padding: 1rem 2rem;
      border-radius: 0.5rem;
      margin: 0 1rem;
      border: none;
      background-color: #0f0f0f;
      color: white;
      cursor: pointer;
      margin-bottom: 1rem;
      &:hover {
        background-color: #1f1f1f;
      }
    }
  }
`

const FileSystemAccessPopup = () => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    (async () => {
      const enabled = await get('file-system-access-enabled')
      if (typeof enabled === 'boolean') return
      if (await window.showDirectoryPicker === undefined) return
      setOpen(true)
    })()
  }, [])

  const onChooseFolder = async () => {
    set('file-system-access-enabled', true)
    const handle = await window.showDirectoryPicker()
    set('file-system-access-handle', handle)
    setOpen(false)
  }

  const onClose = () => {
    set('file-system-access-enabled', false)
    setOpen(false)
  }

  return (
    <Modal open={open} onClose={onClose}>
      <div css={style}>
        <div className="content">
          <h2>File System Access</h2>
          <p>It seems like your browser supports <a href="https://developer.chrome.com/articles/file-system-access/">FSA</a>.</p>
          <p>You can select a folder to write the torrents files to, to improve drive efficiency</p>
          <p>Ripple will only be able to see and write to the selected folder and you can remove the permission at any time</p>
          <span>
            <span><button onClick={onChooseFolder}>Choose a folder</button></span>
            <span><button onClick={onClose}>I do not want to</button></span>
          </span>
        </div>
      </div>
    </Modal>
  )
}

export default FileSystemAccessPopup
