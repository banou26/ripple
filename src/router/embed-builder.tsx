import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'

import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'
import { useEffect, useMemo, useState } from 'react'

import type { EmbedMode } from './file-selection'

import { pickVideoFile } from '../torrent/watch'
import { getHumanReadableByteString } from '../utils/bytes'
import { compileFileSelection, embedIframe, embedPath, embedUrl } from './embed-link'

const style = css`
  flex: none;
  margin: 14px 16px 0;
  padding: 14px 18px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;

  .head {
    display: flex;
    align-items: center;
    gap: 10px;

    label {
      flex: 1;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #8b8499;
    }

    button {
      flex: none;
      border: 1px solid #3a3447;
      border-radius: 4px;
      background: ${CONTROL_BG};
      color: #f4f2f8;
      padding: 4px 12px;
      font-size: 0.75rem;
      font-weight: 700;

      &:hover { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }
    }
  }

  .pick {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 22px 16px;
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

    .chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;

      button {
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border: 1px solid #3a3447;
        border-radius: 4px;
        background: ${CONTROL_BG};
        color: #f4f2f8;
        padding: 5px 13px;
        font-size: 0.78rem;
        font-weight: 700;

        &:hover { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }
      }
    }
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
    transition: border-color 120ms ease, box-shadow 120ms ease;

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
      transition: color 120ms ease;
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

      button {
        border: 1px solid #3a3447;
        border-radius: 4px;
        background: ${CONTROL_BG};
        color: #f4f2f8;
        padding: 3px 11px;
        font-size: 0.72rem;
        font-weight: 700;

        &:hover { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }
      }
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

    a, button {
      flex: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      text-decoration: none;
      border: 1px solid #3a3447;
      background: ${CONTROL_BG};
      color: #f4f2f8;

      &:hover { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }

      /* The panel's main action, marked by an accent border rather than by a fill of its own: it
         keeps the same shape and the same weight as the buttons beside it, which is the whole point
         of not having a white button any more. */
      &.primary {
        border: 1px solid rgba(249, 115, 22, 0.55);
        background: ${CONTROL_HOVER_BG};
        color: #f4f2f8;

        &:hover { border-color: #f97316; }
      }
    }
  }

  .snippet {
    summary {
      cursor: pointer;
      color: #a39db3;
      font-size: 0.8rem;
      user-select: none;
      transition: color 120ms ease;
      &:hover { color: #c9c4d4; }
    }

    .out {
      margin-top: 8px;
    }

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
    font-size: 0.75rem;
    color: #fbbf24;
  }

  @media (max-width: 700px) {
    .opt > label { width: auto; }
  }
`

const leaf = (path: string) => path.split('/').pop() || path

type Props = {
  /** Everything in the library, offered as chips so a link can be built without dropping anything. */
  torrents: Torrent[]
  torrent: Torrent | null
  /** True while a drag is over the page, so the empty state can show where it will land. */
  dragging: boolean
  onSelect: (id: string | null) => void
  onClose: () => void
  onToast: (message: string) => void
}

export const EmbedBuilder = ({ torrents, torrent, dragging, onSelect, onClose, onToast }: Props) => {
  const [mode, setMode] = useState<EmbedMode>('watch')
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
  useEffect(() => { setPicked(null); setWatchIndex(null) }, [torrent?.id])

  // the player's own default, so an untouched watch link opens what pressing Watch would have
  const defaultWatch = useMemo(() => pickVideoFile(files), [files])
  const fileIndex = watchIndex ?? defaultWatch

  const indices = useMemo(
    () => picked ?? [...Array(fileCount).keys()],
    [picked, fileCount],
  )

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

  return (
    <section css={style} className="surface embed" aria-label="Embed link">
      <div className="head">
        <label>Embed link</label>
        {torrent && <button type="button" onClick={() => onSelect(null)}>Change torrent</button>}
        <button type="button" onClick={onClose}>Close</button>
      </div>

      {!torrent
        ? (
          <div className="pick" data-drop={dragging || undefined}>
            <span>Drop a .torrent or a magnet link anywhere on this page</span>
            {torrents.length > 0 && (
              <div className="chips">
                {torrents.map((t) => (
                  <button key={t.id} type="button" onClick={() => onSelect(t.id)}>{t.name}</button>
                ))}
              </div>
            )}
          </div>
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
              <label id="embed-mode">Mode</label>
              <div className="seg" role="group" aria-labelledby="embed-mode">
                <button type="button" data-on={mode === 'watch' || undefined} aria-pressed={mode === 'watch'} onClick={() => setMode('watch')}>Watch</button>
                <button type="button" data-on={mode === 'download' || undefined} aria-pressed={mode === 'download'} onClick={() => setMode('download')}>Download</button>
              </div>
              <span className="note">
                {mode === 'watch'
                  ? 'Plays one file in the media player.'
                  : 'Offers the files for download, more than one as a zip.'}
              </span>
            </div>

            {fileCount === 0
              ? <span className="note">Reading the file list from the network. The link works already and covers the whole torrent.</span>
              : mode === 'watch'
                ? (
                  <div className="opt">
                    <label htmlFor="embed-file">File</label>
                    {/* one file, because the player reads fileIndex and ignores a set entirely */}
                    <select
                      id="embed-file"
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
                      <button type="button" onClick={() => setPicked(null)}>All</button>
                      <button type="button" onClick={() => setPicked([])}>None</button>
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
                    <summary>Frame to paste into a page</summary>
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
    </section>
  )
}

export default EmbedBuilder
