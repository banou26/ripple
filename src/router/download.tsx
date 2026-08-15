import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'

import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'
import { ArrowDown, Download, File as FileIcon, Folder, User } from 'react-feather'

import type { SaveEntry } from '../torrent/save-file'
import type { FileSelection } from './file-selection'
import {
  DownloadUnavailableError,
  isSaveCancelled,
  saveTorrentEntriesAsZipToDisk,
  saveTorrentFileToDisk,
} from '../torrent/save-file'
import { magnetParam } from '../torrent/magnet'
import { useDownloadTorrent } from '../torrent/use-download-torrent'
import { getHumanReadableByteString } from '../utils/bytes'
import { firstIndexOf, resolveSelection } from './file-selection'

const style = css`
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background:
    radial-gradient(1100px 500px at 75% -5%, #2b1f3f 0%, transparent 60%),
    radial-gradient(900px 420px at -10% 110%, #221a31 0%, transparent 55%),
    #16131c;
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  a { text-decoration: none; }

  button {
    font-family: inherit;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
    &:active { transform: scale(0.98); }
    &:disabled { cursor: default; }
  }

  .card {
    width: 100%;
    max-width: 560px;
    /* the page is scrollable and centred, so the card never dictates the height of a short embed */
    margin: auto;
    padding: 26px 24px;
    border-radius: 8px;
    background: rgba(30, 26, 40, 0.66);
    border: 1px solid rgba(44, 39, 55, 0.9);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.03),
      0 4px 14px -4px rgba(0, 0, 0, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(12px) saturate(1.2);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .wordmark {
    align-self: center;
    font-size: 1.1rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    background: linear-gradient(90deg, #fbbf24, #f97316);
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
  }

  .subject {
    display: flex;
    align-items: flex-start;
    gap: 14px;

    .glyph {
      flex: none;
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      border: 1px solid rgba(249, 115, 22, 0.35);
      background: rgba(249, 115, 22, 0.08);
      color: #fbbf24;

      svg { width: 22px; height: 22px; }
    }

    .about {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .name {
      font-size: 1.05rem;
      font-weight: 600;
      line-height: 1.4;
      /* a release name is one long token with no spaces, so it has to be allowed to break anywhere */
      overflow-wrap: anywhere;
    }

    .meta {
      color: #8b8499;
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
    }
  }

  .cta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 14px 20px;
    border: none;
    border-radius: 6px;
    background: linear-gradient(90deg, #fbbf24, #f97316);
    color: #16131c;
    font-size: 1rem;
    font-weight: 800;
    box-shadow: 0 6px 18px -6px rgba(249, 115, 22, 0.7);

    svg { width: 18px; height: 18px; }

    &:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 10px 22px -8px rgba(249, 115, 22, 0.85);
    }

    &:disabled { opacity: 0.55; box-shadow: none; }
  }

  .cancel {
    align-self: center;
    border: 1px solid #3a3447;
    border-radius: 4px;
    background: ${CONTROL_BG};
    color: #f4f2f8;
    padding: 6px 16px;
    font-size: 0.8rem;
    font-weight: 700;

    &:hover { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .bar {
      height: 6px;
      border-radius: 2px;
      background: rgba(44, 39, 55, 0.9);
      overflow: hidden;

      .fill {
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, #fbbf24, #f97316);
        box-shadow: 0 0 10px rgba(249, 115, 22, 0.45);
        transition: width 300ms ease;
      }
    }

    .line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: #a39db3;
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;
    }
  }

  .swarm {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 18px;
    color: #8b8499;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;

    .item { display: flex; align-items: center; gap: 5px; }
    svg { width: 14px; height: 14px; }
  }

  .note {
    color: #8b8499;
    font-size: 0.8rem;
    line-height: 1.6;
    text-align: center;

    a { color: #fbbf24; &:hover { text-decoration: underline; } }
  }

  .failure {
    color: #fbbf24;
    font-size: 0.85rem;
    line-height: 1.6;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .done {
    color: #7dd3a0;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
  }

  .files {
    border-top: 1px solid rgba(44, 39, 55, 0.9);
    padding-top: 4px;

    summary {
      cursor: pointer;
      color: #a39db3;
      font-size: 0.8rem;
      user-select: none;
      padding: 8px 0;
      transition: color 120ms ease;
      &:hover { color: #c9c4d4; }
    }

    /* capped and scrolled: a season pack is 24 rows and would push the button off a phone screen */
    .list {
      max-height: 220px;
      overflow-y: auto;
      /* the row button ends flush against the scrollbar without this, to a third of a pixel */
      padding-right: 8px;
    }

    .file {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 7px 0;
      border-top: 1px solid rgba(44, 39, 55, 0.9);
      font-size: 0.8rem;

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

      button {
        flex: none;
        border: 1px solid #3a3447;
        border-radius: 4px;
        background: ${CONTROL_BG};
        color: #f4f2f8;
        padding: 4px 12px;
        font-size: 0.75rem;

        &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: rgba(249, 115, 22, 0.35); }
        &:disabled { opacity: 0.5; }
      }
    }
  }
`

/** Whether this document is framed by another origin, which decides whether to offer a way out. */
const framedByAnotherOrigin = (): boolean => {
  if (typeof window === 'undefined') return false
  const top = window.top
  if (!top || top === window.self) return false
  try {
    void top.location.origin
    return false
  } catch {
    return true
  }
}

/**
 * `total` is the job's OWN size, not the page's selection.
 *
 * Downloading one file out of a season pack from its row would otherwise report its progress against
 * the whole pack, so a finished 1.4 GB episode reads as "1.4 GB of 34 GB" and looks stuck at 4%.
 */
type Job = { fraction: number, label: string, total: number } | null

type Props = {
  magnet: string | undefined
  selection: FileSelection
}

const DownloadPage = ({ magnet, selection }: Props) => {
  /**
   * The first file of the selection, resolved before the file list exists.
   *
   * It seeds the engine claim, and the claim is what keeps an ephemeral torrent off the idle-pause
   * path, so it has to be available on the very first render rather than after metadata lands. An
   * `all` selection starts at 0, which is also where a zip starts writing.
   *
   * It is a HINT, not a checked index: nothing here knows how many files the torrent has yet. The
   * hook clamps it against the real list at the moment it claims, which matters, because a claim the
   * engine cannot resolve writes no priority map at all and leaves the torrent downloading
   * everything.
   */
  const firstIndex = useMemo(() => firstIndexOf(selection), [selection])

  const { client, snapshot, handle, viewer, engineError, storageFull } = useDownloadTorrent(magnet, firstIndex)

  const [job, setJob] = useState<Job>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [finished, setFinished] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const files = snapshot?.files?.files
  const indices = useMemo(() => resolveSelection(selection, files?.length ?? 0), [selection, files?.length])

  const entries: SaveEntry[] = useMemo(
    () => (files ? indices.map((index) => ({ index, path: files[index]!.path, size: files[index]!.size })) : []),
    [files, indices],
  )
  const totalBytes = entries.reduce((n, e) => n + e.size, 0)

  const torrentName = useMemo(
    () => (magnet ? magnetParam(magnet, 'dn') : undefined)
      ?? files?.[0]?.path.split('/')[0]
      ?? 'this torrent',
    [magnet, files],
  )

  const single = entries.length === 1 ? entries[0]! : null
  // libtorrent reports a path relative to the torrent root, so a multi-file release repeats its
  // folder in front of every entry; the folder is already the heading here
  const leaf = (path: string) => path.split('/').pop() || path

  const subjectName = single ? leaf(single.path) : torrentName
  const framed = useMemo(framedByAnotherOrigin, [])
  const openHere = typeof window === 'undefined'
    ? null
    : window.location.origin + window.location.pathname + window.location.search

  const start = useCallback((chosen: SaveEntry[], label: string) => {
    // Called straight from the click with nothing awaited before it: the save picker and the service
    // worker handshake both spend the gesture's transient activation, and an await here loses it.
    if (handle == null || !chosen.length || abortRef.current) return
    const controller = new AbortController()
    abortRef.current = controller
    setFailure(null)
    setFinished(null)
    setJob({ fraction: 0, label, total: chosen.reduce((n, e) => n + e.size, 0) })

    const options = { viewer, signal: controller.signal }
    const onProgress = (fraction: number) => setJob((j) => (j ? { ...j, fraction } : j))
    const only = chosen.length === 1 ? chosen[0]! : null

    const run = only
      ? saveTorrentFileToDisk(client, handle, only.index, only.path, only.size, onProgress, options)
      : saveTorrentEntriesAsZipToDisk(client, handle, torrentName, chosen, onProgress, options)

    run
      .then(() => setFinished(only ? leaf(only.path) : `${chosen.length} files`))
      .catch((error: unknown) => {
        if (isSaveCancelled(error)) return
        setFailure(
          error instanceof DownloadUnavailableError
            ? error.message
            : `The download stopped: ${(error as Error)?.message ?? 'unknown error'}`,
        )
      })
      .finally(() => {
        abortRef.current = null
        setJob(null)
      })
  }, [client, handle, viewer, torrentName])

  const cancel = () => abortRef.current?.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

  /**
   * A page that goes away takes its download with it.
   *
   * The engine claim is released on unmount, and an ephemeral torrent with no viewers is paused, so
   * an export left running past this point would block on reads that can no longer be served and
   * spend four 120s timeouts finding that out, writing into a sink whose frame is already gone.
   */
  useEffect(() => () => cancel(), [])

  /**
   * An engine reset invalidates the handle an export is already holding.
   *
   * The handle is a session-local number captured when Download was pressed, and the engine hands
   * the same numbers out again to whatever the next session adds, so an export that keeps reading
   * across a reset is asking a different torrent for its bytes. Stopping is the only safe answer,
   * and saying why beats a read error four retries later.
   */
  useEffect(() => client.onEngineReset(() => {
    if (!abortRef.current) return
    cancel()
    setFailure('The download engine restarted, so the download stopped. Start it again.')
  }), [client])

  const status = engineError
    ?? (storageFull ? 'Out of storage space. Remove a download in Ripple to free room.' : null)

  const peers = snapshot?.status?.numPeers ?? 0
  const rate = snapshot?.displayDownloadRate ?? 0

  const busy = job !== null
  const ready = Boolean(files) && entries.length > 0 && handle != null
  const label = !magnet
    ? 'Nothing to download'
    : !files
      ? 'Loading torrent…'
      : entries.length === 0
        ? 'No matching files'
        : busy
          ? job.label
          : single
            ? 'Download'
            : `Download ${entries.length} files as .zip`

  return (
    <div css={style}>
      <div className="card">
        <span className="wordmark">Ripple</span>

        <div className="subject">
          <div className="glyph">{single ? <FileIcon /> : <Folder />}</div>
          <div className="about">
            <div className="name">{subjectName}</div>
            <div className="meta">
              {files
                ? entries.length === 0
                  ? 'None of the requested files are in this torrent'
                  : `${getHumanReadableByteString(totalBytes)}${single ? '' : ` · ${entries.length} files`}`
                : 'Reading the torrent from the network'}
            </div>
          </div>
        </div>

        <button className="cta" onClick={() => start(entries, 'Downloading')} disabled={!ready || busy}>
          {!busy && <Download />}
          {label}
        </button>

        {busy && (
          <div className="progress">
            <div className="bar"><div className="fill" style={{ width: `${Math.round(job.fraction * 100)}%` }} /></div>
            <div className="line">
              <span>{Math.round(job.fraction * 100)}%</span>
              <span>{getHumanReadableByteString(job.fraction * job.total)} of {getHumanReadableByteString(job.total)}</span>
            </div>
          </div>
        )}

        {busy && <button className="cancel" onClick={cancel}>Cancel</button>}

        {status && <div className="failure">{status}</div>}
        {failure && <div className="failure">{failure}</div>}
        {finished && <div className="done">Saved {finished}</div>}

        {/* what the swarm is doing, which is the only explanation of a download that is not moving */}
        {Boolean(files) && !status && (
          <div className="swarm" data-testid="swarm">
            <span className="item"><User />{peers} peers</span>
            <span className="item"><ArrowDown />{getHumanReadableByteString(rate, true)}/s</span>
          </div>
        )}

        {entries.length > 1 && (
          <details className="files">
            <summary>{entries.length} files</summary>
            <div className="list">
              {entries.map((entry) => (
                <div className="file" key={entry.index}>
                  <span className="name">{leaf(entry.path)}</span>
                  <span className="size">{getHumanReadableByteString(entry.size)}</span>
                  {/**
                    * Shows "Download" and ANNOUNCES the file, because the visible label is only
                    * unambiguous next to the name in the same row. Read on its own, as a screen
                    * reader's element list does, a season pack is otherwise 24 buttons that all say
                    * the same word. The visible text stays a prefix of the accessible name, so
                    * "click Download" still addresses this button by voice.
                    */}
                  <button
                    aria-label={`Download ${leaf(entry.path)}`}
                    onClick={() => start([entry], `Downloading ${leaf(entry.path)}`)}
                    disabled={!ready || busy}
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}

        {/**
          * A framed page cannot know whether its embedder granted `allow-downloads`, and a refusal is
          * silent: the frame navigation is dropped, no event fires and nothing throws. So the way out
          * is offered up front rather than after a download that quietly never started.
          */}
        {framed && openHere && (
          <div className="note">
            Download not starting? <a href={openHere} target="_blank" rel="noreferrer">Open this page in Ripple</a>.
          </div>
        )}
      </div>
    </div>
  )
}

export default DownloadPage
