import { useEffect, useRef, useState } from 'react'
import { css } from '@emotion/react'

import type { AddChoices } from '../torrent/add-options'
import type { SaveLocation } from '../torrent/library'
import type { TorrentFile } from '../torrent/types'

import {
  choicesProblem, selectAll, selectedBytes, selectNone, toggleFile,
} from '../torrent/add-options'
import { getHumanReadableByteString } from '../utils/bytes'

/**
 * What is in this torrent, and which of it do you want?
 *
 * Native `<dialog>` and `showModal()`, matching the other two dialogs, which buys the top layer and
 * the focus trap without reimplementing either.
 *
 * It is the same dialog for two arrivals that feel different. A torrent the person added themselves
 * only gets it when they have asked for it, since it is friction in front of a question whose answer
 * is usually "all of it, now". A torrent arriving from another site through `/add` ALWAYS gets it,
 * because that one is a proposal from a stranger and this is where they agree to it. Hence
 * `external`, which changes the wording and hides the "do not ask again" checkbox: a setting that
 * could switch off the consent step for links from anywhere is not one worth offering.
 */

const style = css`
  border: none;
  padding: 0;
  background: none;
  max-width: none;
  max-height: none;
  width: 100%;
  height: 100%;

  &::backdrop {
    background: rgba(8, 6, 12, 0.72);
    backdrop-filter: blur(3px);
  }

  display: flex;
  align-items: center;
  justify-content: center;

  .card {
    width: min(760px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: #17141d;
    border: 1px solid #2c2737;
    border-radius: 16px;
    color: #f4f2f8;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  header {
    padding: 20px 24px 14px;
    border-bottom: 1px solid #221e2b;

    h2 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
      word-break: break-word;
    }

    .from {
      margin: 6px 0 0;
      font-size: 0.8rem;
      color: #8b8499;

      b { color: #c9c4d4; }
    }
  }

  .body {
    padding: 18px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;

    > label {
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #8b8499;
    }
  }

  .files {
    border: 1px solid #2c2737;
    border-radius: 10px;
    max-height: 260px;
    overflow-y: auto;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 12px;
    font-size: 0.85rem;
    border-bottom: 1px solid #221e2b;
    cursor: pointer;

    &:last-child { border-bottom: none; }
    &:hover { background: #1d1926; }

    input { accent-color: #f97316; flex-shrink: 0; }

    .path {
      flex: 1;
      min-width: 0;
      word-break: break-word;
      .dir { color: #8b8499; }
    }

    .size {
      flex-shrink: 0;
      color: #8b8499;
      font-variant-numeric: tabular-nums;
    }

    &.off .path { color: #6b6579; text-decoration: line-through; }
  }

  .bulk {
    display: flex;
    gap: 8px;
    align-items: center;

    .count {
      margin-left: auto;
      font-size: 0.8rem;
      color: #8b8499;
      font-variant-numeric: tabular-nums;
    }
  }

  .toggles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 10px 20px;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 0.85rem;
    cursor: pointer;
    line-height: 1.4;

    input { accent-color: #f97316; margin-top: 2px; flex-shrink: 0; }

    .hint {
      display: block;
      color: #8b8499;
      font-size: 0.78rem;
    }
  }

  .waiting {
    font-size: 0.85rem;
    color: #8b8499;
  }

  .problem {
    font-size: 0.85rem;
    color: #f8a5a5;
  }

  footer {
    padding: 14px 24px 18px;
    border-top: 1px solid #221e2b;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;

    .spacer { margin-left: auto; }
  }

  button {
    font: inherit;
    font-size: 0.85rem;
    padding: 8px 18px;
    border-radius: 999px;
    border: 1px solid #2c2737;
    background: none;
    color: #c9c4d4;
    cursor: pointer;

    &:hover:not(:disabled) { border-color: #3a3447; color: #f4f2f8; }
    &:disabled { opacity: 0.45; cursor: default; }

    &.primary {
      background: #f97316;
      border-color: #f97316;
      color: #1a1020;
      font-weight: 600;

      &:hover:not(:disabled) { background: #fb8a3c; }
    }

    &.small { padding: 5px 12px; font-size: 0.78rem; }
  }
`

const FilePath = ({ path }: { path: string }) => {
  const cut = path.lastIndexOf('/')
  return cut < 0
    ? <>{path}</>
    : <><span className="dir">{path.slice(0, cut + 1)}</span>{path.slice(cut + 1)}</>
}

export const AddTorrentDialog = ({
  name, from, files, choices, onChoices, folderName, folderReady, external, onConfirm, onCancel, onNeverAsk,
}: {
  name: string
  /** the origin that linked here, for a torrent arriving from another site */
  from?: string | null
  /** empty until the metadata arrives, which is the only place a magnet's file list comes from */
  files: TorrentFile[]
  choices: AddChoices
  onChoices: (choices: AddChoices) => void
  folderName?: string
  folderReady?: boolean
  external?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** absent for an external add, where switching the step off is not on offer */
  onNeverAsk?: () => void
}) => {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [neverAsk, setNeverAsk] = useState(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // Cancel, not Add. showModal's own rule would land on the first focusable control, which arms
    // Enter to accept something nobody has read yet, and this one is a stranger's proposal.
    cancelRef.current?.focus()
  }, [])

  const ready = files.length > 0
  const problem = ready ? choicesProblem(choices) : null
  const total = files.reduce((n, f) => n + f.size, 0)
  const selected = selectedBytes(choices, files)

  const set = (patch: Partial<AddChoices>) => onChoices({ ...choices, ...patch })

  const confirm = () => {
    if (problem || !ready) return
    if (neverAsk) onNeverAsk?.()
    onConfirm()
  }

  return (
    <dialog
      ref={ref}
      css={style}
      aria-labelledby="add-torrent-title"
      onCancel={(e) => { e.preventDefault(); onCancel() }}
      onClick={(e) => { if (e.target === ref.current) onCancel() }}
    >
      <div className="card">
        <header>
          <h2 id="add-torrent-title">{name}</h2>
          <p className="from">
            {external
              ? <>{from ? <>Sent here by <b>{from}</b>. </> : <>Opened from a link. </>}Nothing is added until you say so.</>
              : <>Choose what to download before it starts.</>}
          </p>
        </header>

        <div className="body">
          <div className="group">
            <label>Files</label>
            {ready
              ? (
                <>
                  <div className="bulk">
                    <button className="small" onClick={() => onChoices(selectAll(choices, files.length))}>Select all</button>
                    <button className="small" onClick={() => onChoices(selectNone(choices))}>Select none</button>
                    <span className="count">
                      {getHumanReadableByteString(selected, true)} of {getHumanReadableByteString(total, true)}
                      {', '}{choices.files.length} of {files.length} files
                    </span>
                  </div>
                  <div className="files">
                    {files.map((file, index) => {
                      const on = choices.files.includes(index)
                      return (
                        <label className={on ? 'file' : 'file off'} key={file.name}>
                          <input type="checkbox" checked={on} onChange={() => onChoices(toggleFile(choices, index))}/>
                          <span className="path"><FilePath path={file.name}/></span>
                          <span className="size">{getHumanReadableByteString(file.size, true)}</span>
                        </label>
                      )
                    })}
                  </div>
                </>
              )
              : <p className="waiting">Reading the file list from the swarm...</p>}
            {problem && <p className="problem">{problem}</p>}
          </div>

          {folderReady && (
            <div className="group">
              <label>Where the files go</label>
              <div className="toggles">
                <label className="check">
                  <input
                    type="radio"
                    name="add-location"
                    checked={choices.location === 'browser'}
                    onChange={() => set({ location: 'browser' as SaveLocation })}
                  />
                  <span>
                    Browser storage
                    <span className="hint">Private to this browser, and counts against its quota.</span>
                  </span>
                </label>
                <label className="check">
                  <input
                    type="radio"
                    name="add-location"
                    checked={choices.location === 'folder'}
                    onChange={() => set({ location: 'folder' as SaveLocation })}
                  />
                  <span>
                    {folderName ?? 'Your folder'}
                    <span className="hint">Downloads in the browser, then moves there when it finishes.</span>
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="group">
            <label>How it starts</label>
            <div className="toggles">
              <label className="check">
                <input type="checkbox" checked={choices.start} onChange={(e) => set({ start: e.currentTarget.checked })}/>
                <span>
                  Start downloading
                  <span className="hint">Off adds it to the library and leaves it paused.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={choices.sequential} onChange={(e) => set({ sequential: e.currentTarget.checked })}/>
                <span>
                  Sequential download
                  <span className="hint">Front to back, so it can be watched early. Usually slower.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={choices.topOfQueue} onChange={(e) => set({ topOfQueue: e.currentTarget.checked })}/>
                <span>
                  Put it first
                  <span className="hint">Ahead of everything already waiting to run.</span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <footer>
          {onNeverAsk && (
            <label className="check">
              <input type="checkbox" checked={neverAsk} onChange={(e) => setNeverAsk(e.currentTarget.checked)}/>
              <span>Do not ask again</span>
            </label>
          )}
          <span className="spacer"/>
          <button ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!ready || !!problem}>Add torrent</button>
        </footer>
      </div>
    </dialog>
  )
}

export default AddTorrentDialog
