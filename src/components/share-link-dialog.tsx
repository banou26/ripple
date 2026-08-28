import type { ShareSubject } from '../torrent/torrent-file'

import { css } from '@emotion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { EmbedMode } from '../router/file-selection'

import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'
import { embedIframe, embedPath, embedUrl } from '../router/embed-link'
import { canOfferWatch, pickVideoFile } from '../torrent/watch'
import { getHumanReadableByteString } from '../utils/bytes'
import { Modal } from './modal'

/**
 * Make a link that opens one torrent on somebody else's device.
 *
 * A modal rather than a panel that appends itself to the library, which is what this replaced. The
 * old shape pushed the list down whenever it opened, and it carried a row of chips for every torrent
 * already in the library, which put two ways to do one thing on the screen at once: sharing
 * something you already have belongs on that row, in its own options menu, next to the other things
 * you can do to it.
 *
 * So this asks for exactly one thing, a torrent it does not have yet, in the two shapes a torrent
 * arrives in: a magnet link pasted in, or a .torrent dropped or picked. Opened from a row's options
 * instead, it is handed the torrent and goes straight to the link.
 *
 * It does not add anything itself. Both inputs go back to the library's own add path, and the
 * torrent reappears here through the same claim the page-wide drop uses, so there is one way in
 * regardless of which surface caught it.
 */

const style = css`
  width: 100%;
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
    border-radius: 8px;
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
    }

    p {
      margin: 6px 0 0;
      max-width: 62ch;
      font-size: 0.8rem;
      line-height: 1.55;
      color: #8b8499;
    }
  }

  .body {
    padding: 18px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* the empty state: one field, one drop zone, nothing else to choose between */
  form.ask {
    display: flex;
    gap: 8px;

    input {
      flex: 1;
      min-width: 0;
      background: rgba(22, 19, 28, 0.8);
      border: 1px solid #2c2737;
      border-radius: 6px;
      padding: 9px 14px;
      color: #f4f2f8;
      font-family: inherit;
      font-size: 0.85rem;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;

      &::placeholder { color: #6b6579; }

      &:focus {
        border-color: #f97316;
        box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
      }
    }
  }

  .or {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #6b6579;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;

    &::before, &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #221e2b;
    }
  }

  .drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 26px 16px;
    border: 2px dashed rgba(58, 52, 71, 0.9);
    border-radius: 8px;
    color: #8b8499;
    font-size: 0.85rem;
    text-align: center;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;

    &[data-drop] {
      border-color: #fbbf24;
      background: rgba(249, 115, 22, 0.06);
      color: #fbbf24;
    }
  }

  /*
   * A file input styled as a button, the same trick the library header uses. The input itself stays
   * in the layout at 1px rather than being display:none, because a hidden input is not focusable and
   * the control would fall out of the tab order.
   */
  .file-button {
    position: relative;
    overflow: hidden;

    input[type='file'] {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
    }
  }

  .waiting {
    font-size: 0.85rem;
    color: #8b8499;
  }

  .subject {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 12px;

    strong {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.95rem;
    }

    .size {
      flex: none;
      font-size: 0.8rem;
      color: #a39db3;
      font-variant-numeric: tabular-nums;
    }
  }

  select {
    flex: 1;
    min-width: 0;
    max-width: 420px;
    background: rgba(22, 19, 28, 0.8);
    border: 1px solid #2c2737;
    border-radius: 6px;
    padding: 7px 14px;
    color: #f4f2f8;
    font-family: inherit;
    font-size: 0.8rem;
    outline: none;
    cursor: pointer;

    &:focus {
      border-color: #f97316;
      box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
    }
  }

  .opt {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;

    > label {
      flex: none;
      width: 62px;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #8b8499;
    }
  }

  .seg {
    display: flex;
    gap: 4px;
    padding: 3px;
    border: 1px solid #2c2737;
    border-radius: 6px;
    background: rgba(22, 19, 28, 0.8);

    button {
      border: none;
      border-radius: 4px;
      background: none;
      color: #a39db3;
      padding: 5px 14px;
      font-size: 0.78rem;
      font-weight: 700;

      &:hover { color: #f4f2f8; }

      &[data-on] {
        background: ${CONTROL_HOVER_BG};
        color: #f4f2f8;
      }
    }
  }

  .note {
    flex: 1;
    min-width: 160px;
    font-size: 0.75rem;
    color: #8b8499;
  }

  .files {
    width: 100%;

    summary {
      cursor: pointer;
      color: #a39db3;
      font-size: 0.8rem;
      user-select: none;
      padding: 4px 0;
      &:hover { color: #c9c4d4; }
    }

    .list {
      max-height: 200px;
      overflow-y: auto;
      padding-right: 8px;
      margin-top: 4px;
    }

    .file {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 0;
      border-top: 1px solid rgba(44, 39, 55, 0.9);
      font-size: 0.8rem;

      input {
        flex: none;
        accent-color: #f97316;
      }

      .name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        color: #b6b0c4;
      }

      .size {
        flex: none;
        color: #8b8499;
        font-variant-numeric: tabular-nums;
      }
    }

    .bulk {
      display: flex;
      gap: 6px;
      padding: 4px 0;
    }
  }

  .out {
    display: flex;
    align-items: center;
    gap: 8px;

    code {
      flex: 1;
      min-width: 0;
      overflow-x: auto;
      white-space: nowrap;
      background: rgba(22, 19, 28, 0.8);
      border: 1px solid #2c2737;
      border-radius: 6px;
      padding: 8px 16px;
      color: #b6b0c4;
      font-size: 0.78rem;
    }

    a {
      flex: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      text-decoration: none;
      border: 1px solid #2c2737;
      background: ${CONTROL_BG};
      color: #c9c4d4;

      &:hover { background: ${CONTROL_HOVER_BG}; border-color: #3a3447; color: #f4f2f8; }
    }
  }

  .snippet {
    summary {
      cursor: pointer;
      color: #a39db3;
      font-size: 0.8rem;
      user-select: none;
      &:hover { color: #c9c4d4; }
    }

    .out { margin-top: 8px; }

    pre {
      flex: 1;
      min-width: 0;
      margin: 0;
      overflow-x: auto;
      background: rgba(22, 19, 28, 0.8);
      border: 1px solid #2c2737;
      border-radius: 6px;
      padding: 10px 14px;
      color: #b6b0c4;
      font-size: 0.72rem;
      line-height: 1.5;
    }
  }

  .warn {
    font-size: 0.8rem;
    color: #fbbf24;
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

  button, .file-button {
    font: inherit;
    font-size: 0.85rem;
    padding: 8px 18px;
    border-radius: 6px;
    border: 1px solid #2c2737;
    background: ${CONTROL_BG};
    color: #c9c4d4;
    cursor: pointer;

    &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: #3a3447; color: #f4f2f8; }
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

  @media (max-width: 700px) {
    .opt > label { width: auto; }
  }
`

const leaf = (path: string) => path.split('/').pop() || path

type Props = {
  /** What to build a link for. Null asks for one, which is the state the header button opens. */
  torrent: ShareSubject | null
  /** True while a drag carrying something addable is over the window. */
  dragging: boolean
  /** Hand a magnet to the library's add path. False means it was not a magnet. */
  onMagnet: (text: string) => boolean
  /** Hand .torrent files to the library's add path. */
  onFiles: (files: Iterable<File>) => void
  /** Forget the current subject and ask for another. */
  onClear: () => void
  onClose: () => void
  onToast: (message: string) => void
}

export const ShareLinkDialog = ({ torrent, dragging, onMagnet, onFiles, onClear, onClose, onToast }: Props) => {
  /**
   * Download by default.
   *
   * Watch was the default because the player is the thing ripple is proudest of, which is not the
   * same as being what somebody sending a link most often wants. A download link works for every
   * torrent, including the ones with nothing playable in them.
   */
  const [mode, setMode] = useState<EmbedMode>('download')
  const [input, setInput] = useState('')
  /**
   * Something was handed over and the torrent it becomes has not arrived yet.
   *
   * The add is asynchronous and lands through the library's claim, so between the two there is a
   * moment with no subject and no explanation. Without this the dialog would sit on the empty state
   * looking like the submit did nothing.
   */
  const [handedOver, setHandedOver] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)

  const files = torrent?.files
  const fileCount = files?.length ?? 0

  /**
   * Which files the link names, as engine indices.
   *
   * `null` is "everything", kept distinct from a checked set that happens to cover everything so the
   * list does not have to be materialised before metadata lands, and so the link stays whole-torrent
   * as files appear rather than freezing at whatever count was known first.
   */
  const [picked, setPicked] = useState<number[] | null>(null)
  const [watchIndex, setWatchIndex] = useState<number | null>(null)

  // a different torrent is a different file list, so nothing about the old selection survives
  // keyed on the magnet, which is what identifies a subject now that it need not be in the library
  useEffect(() => { setPicked(null); setWatchIndex(null) }, [torrent?.magnet])

  // the subject arrived, so the field has done its job and the empty state is behind us
  useEffect(() => { if (torrent) { setHandedOver(false); setInput('') } }, [torrent])

  // the player's own default, so an untouched watch link opens what pressing Watch would have
  const defaultWatch = useMemo(() => pickVideoFile(files ?? undefined), [files])
  const fileIndex = watchIndex ?? defaultWatch

  const indices = useMemo(() => picked ?? [...Array(fileCount).keys()], [picked, fileCount])

  /**
   * Whether Watch is on offer at all.
   *
   * Nothing playable means the player would open on a file it cannot play, so the choice is not
   * offered rather than offered and broken. A magnet whose file list has not arrived keeps both,
   * because "not known yet" is not "not video".
   */
  const watchable = canOfferWatch(files ?? undefined)

  // a subject that turns out to hold nothing playable must not be left on a watch link
  useEffect(() => { if (!watchable) setMode('download') }, [watchable])

  const link = useMemo(
    () => (torrent?.magnet ? { magnet: torrent.magnet, mode, indices, fileCount, fileIndex } : null),
    [torrent?.magnet, mode, indices, fileCount, fileIndex],
  )

  const empty = mode === 'download' && fileCount > 0 && indices.length === 0
  const url = link && !empty ? embedUrl(link) : ''
  const path = link && !empty ? embedPath(link) : ''
  const snippet = link && !empty ? embedIframe(link) : ''

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text)
      .then(() => onToast(`${what} copied`))
      // a refused clipboard is not a broken link, so say which it was
      .catch(() => onToast(`Could not copy the ${what.toLowerCase()}. Select it and copy by hand.`))
  }

  const toggle = (index: number) =>
    setPicked((prev) => {
      const set = new Set(prev ?? [...Array(fileCount).keys()])
      if (set.has(index)) set.delete(index)
      else set.add(index)
      return [...set].sort((a, b) => a - b)
    })

  const submitMagnet = (event: React.FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    // the add path reports a non-magnet itself, so the dialog only has to not claim one
    if (onMagnet(text)) setHandedOver(true)
  }

  const chooseFiles = (list: FileList | null) => {
    if (!list?.length) return
    setHandedOver(true)
    onFiles(list)
  }

  const back = () => { setHandedOver(false); setInput(''); onClear() }

  return (
    <Modal labelledBy="share-link-title" onClose={onClose} initialFocus={fieldRef}>
      <div css={style}>
        <div className="card">
          <header>
            <h2 id="share-link-title">Share link</h2>
            <p>
              Makes a link that opens one torrent on any device, with no Ripple account and nothing
              to install. Send it to somebody, or put it on a page.
            </p>
          </header>

          <div className="body">
            {!torrent
              ? (
                <>
                  <form className="ask" onSubmit={submitMagnet}>
                    <input
                      ref={fieldRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.currentTarget.value)}
                      placeholder="Paste a magnet link"
                      aria-label="Magnet link"
                      spellCheck={false}
                    />
                    <button type="submit" className="primary" disabled={!input.trim()}>Make link</button>
                  </form>

                  <div className="or">or</div>

                  {/* No drop handler of its own: the window listener already turns a drop anywhere
                      into an add, and a second handler here would add the same file twice. This
                      shows WHERE it lands and offers the picker for people who would rather click. */}
                  <div className="drop" data-drop={dragging || undefined}>
                    <span>Drop a .torrent file anywhere on this window</span>
                    <label className="file-button">
                      Choose a file
                      <input
                        type="file"
                        accept=".torrent,application/x-bittorrent"
                        multiple
                        onChange={(e) => { chooseFiles(e.currentTarget.files); e.currentTarget.value = '' }}
                      />
                    </label>
                  </div>

                  {handedOver && <p className="waiting">Reading the torrent...</p>}
                </>
              )
              : (
                <>
                  <div className="subject">
                    <strong>{torrent.name}</strong>
                    <span className="size">
                      {getHumanReadableByteString(torrent.size)}
                      {fileCount > 0 && ` · ${fileCount} file${fileCount === 1 ? '' : 's'}`}
                    </span>
                  </div>

                  <div className="opt">
                    <label id="share-mode">The link</label>
                    {/* one option is not a choice, so nothing to press is offered when Watch is out */}
                    {watchable && (
                      <div className="seg" role="group" aria-labelledby="share-mode">
                        <button type="button" data-on={mode === 'watch' || undefined} aria-pressed={mode === 'watch'} onClick={() => setMode('watch')}>Watch</button>
                        <button type="button" data-on={mode === 'download' || undefined} aria-pressed={mode === 'download'} onClick={() => setMode('download')}>Download</button>
                      </div>
                    )}
                    <span className="note">
                      {mode === 'watch'
                        ? 'Opens the player and starts playing while the file downloads.'
                        : watchable
                          ? 'Opens a page with a Download button. Several files arrive as one .zip.'
                          : 'Opens a page with a Download button. There is nothing here the player can open, so a watch link is not offered.'}
                    </span>
                  </div>

                  {/*
                    * Nothing to choose between with a single file, so nothing is offered.
                    *
                    * The link is byte for byte the same either way, which is what makes this purely
                    * a matter of not asking a question with one answer: `compileFileSelection`
                    * returns null once the selection covers every file, and `embedPath` omits
                    * `fileIndex` when it is 0, so a one-file torrent emits neither parameter
                    * whether the controls are on screen or not. The subject line above already
                    * says the name and "1 file".
                    */}
                  {fileCount === 0
                    ? <span className="note">Reading the file list from the network. The link works already and covers the whole torrent.</span>
                    : fileCount === 1
                    ? null
                    : mode === 'watch'
                      ? (
                        <div className="opt">
                          <label htmlFor="share-file">File</label>
                          {/* one file, because the player reads fileIndex and ignores a set entirely */}
                          <select
                            id="share-file"
                            value={fileIndex}
                            onChange={(e) => setWatchIndex(Number(e.currentTarget.value))}
                          >
                            {files!.map((f, i) => (
                              <option key={i} value={i}>{leaf(f.name)} · {getHumanReadableByteString(f.size)}</option>
                            ))}
                          </select>
                        </div>
                      )
                      : (
                        <details className="files">
                          <summary>
                            {indices.length === fileCount
                              ? `All ${fileCount} files`
                              : `${indices.length} of ${fileCount} files`}
                          </summary>
                          <div className="bulk">
                            <button type="button" className="small" onClick={() => setPicked(null)}>All</button>
                            <button type="button" className="small" onClick={() => setPicked([])}>None</button>
                          </div>
                          <div className="list">
                            {files!.map((f, i) => (
                              <label className="file" key={i}>
                                <input type="checkbox" checked={indices.includes(i)} onChange={() => toggle(i)} />
                                <span className="name">{leaf(f.name)}</span>
                                <span className="size">{getHumanReadableByteString(f.size)}</span>
                              </label>
                            ))}
                          </div>
                        </details>
                      )}

                  {!link
                    ? <span className="warn">This torrent has no magnet yet, so it cannot be linked.</span>
                    : empty
                    /* an absent files= means ALL, so there is no link that means "none of them" */
                    ? <span className="warn">Pick at least one file. A link with none would hand over the whole torrent.</span>
                    : (
                      <>
                        <div className="out">
                          <code data-testid="embed-url">{url}</code>
                          <button type="button" className="primary" onClick={() => copy(url, 'Link')}>Copy</button>
                          <a href={path} target="_blank" rel="noreferrer">Open</a>
                        </div>

                        <details className="snippet">
                          <summary>Put it on a web page instead</summary>
                          <div className="out">
                            <pre data-testid="embed-iframe">{snippet}</pre>
                            <button type="button" onClick={() => copy(snippet, 'Frame')}>Copy</button>
                          </div>
                          {mode === 'download' && (
                            <span className="note">
                              allow-downloads is required. Sandbox flags combine with the page above, so a
                              frame cannot add back what its embedder left out.
                            </span>
                          )}
                        </details>
                      </>
                    )}
                </>
              )}
          </div>

          <footer>
            {torrent && <button type="button" onClick={back}>Use a different torrent</button>}
            <span className="spacer"/>
            <button type="button" onClick={onClose}>Close</button>
          </footer>
        </div>
      </div>
    </Modal>
  )
}

export default ShareLinkDialog
