import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'

import {
  BORDER,
  BORDER_STRONG,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  DANGER,
  EMPHASIS,
  EMPHASIS_HOVER,
  OK,
  PAGE_BG,
  SUNKEN_BG,
  SURFACE_BG,
  TEXT,
  TEXT_FAINT,
  TEXT_MUTED,
  TEXT_ON_LIGHT,
} from '../theme'
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
import type { PreviewFile } from './file-list-codec'
import { resolveSelection } from './file-selection'

const style = css`
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: ${PAGE_BG};
  color: ${TEXT};
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
    /* opaque rather than translucent: the old 66% fill leaned on a backdrop blur to stay readable
       over the page's own glows, and both of those are gone, so the border is now the only thing
       separating card from page. */
    background: ${SURFACE_BG};
    border: 1px solid ${BORDER};
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .wordmark {
    align-self: center;
    font-size: 1.1rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    color: ${TEXT};
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
      /* An opaque fill where this used to be an 8% tint. Not because a neutral tint would be
         fainter, it would in fact be marginally lighter than this fill (white at 8% over the card
         composites to #2a2a2a against CONTROL_BG's #242424), but because at 1.2:1 either way the
         fill is not what draws the tile: the border is. So the fill goes to the token every other
         control uses and the 1px BORDER does the work it was already doing. */
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT};

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
      color: ${TEXT_FAINT};
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
    background: ${EMPHASIS};
    color: ${TEXT_ON_LIGHT};
    font-size: 1rem;
    font-weight: 800;

    svg { width: 18px; height: 18px; }

    /* Down, not up: EMPHASIS is already the brightest fill the palette has, so the hover steps to
       EMPHASIS_HOVER, the one value the palette picks for this. The label is restated so the light
       fill and the dark label always travel together. No lift: it used to rise a pixel against a
       growing amber glow, and with the glow gone the movement is just the button twitching. The
       press still answers, through the scale on :active. */
    &:hover:not(:disabled) {
      background: ${EMPHASIS_HOVER};
      color: ${TEXT_ON_LIGHT};
    }

    /* the fill is light, so dimming the whole button keeps the label at 5.8:1 against it over the
       card and the disabled state stays readable, which matters: this button spends the entire
       metadata-loading phase disabled with "Loading torrent…" written on it */
    &:disabled { opacity: 0.55; }
  }

  .cancel {
    align-self: center;
    border: 1px solid ${BORDER};
    border-radius: 4px;
    background: ${CONTROL_BG};
    color: ${TEXT};
    padding: 6px 16px;
    font-size: 0.8rem;
    font-weight: 700;

    &:hover { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .bar {
      height: 6px;
      border-radius: 2px;
      /* a hole punched in the card, so the fill is read against the darkest thing on screen. The
         fill used to be told apart from its track by hue and needed a 10px bloom to make 6px of it
         feel like anything; brightness does both jobs at 17:1 and needs no help. */
      background: ${SUNKEN_BG};
      overflow: hidden;

      .fill {
        height: 100%;
        border-radius: 2px;
        background: ${EMPHASIS};
        transition: width 300ms ease;
      }
    }

    .line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: ${TEXT_MUTED};
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;
    }
  }

  .swarm {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 18px;
    color: ${TEXT_FAINT};
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;

    .item { display: flex; align-items: center; gap: 5px; }
    svg { width: 14px; height: 14px; }
  }

  .note {
    color: ${TEXT_FAINT};
    font-size: 0.8rem;
    line-height: 1.6;
    text-align: center;

    /* underlined at rest, not on hover. Colour used to be the only thing separating this link from
       the sentence it sits in, and there is no colour left to spend on it. */
    a { color: ${TEXT}; text-decoration: underline; }
  }

  /* Red, where every one of these used to be amber. They are outcomes, not cautions: an engine
     failure, a full origin and a stopped export all mean the download is not happening, and the
     line renders directly above a .note at nearly its size (0.85rem against 0.8rem), so it needs
     to not read as more prose. */
  .failure {
    color: ${DANGER};
    font-size: 0.85rem;
    line-height: 1.6;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .done {
    color: ${OK};
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
  }

  .files {
    border-top: 1px solid ${BORDER};
    padding-top: 4px;

    summary {
      cursor: pointer;
      color: ${TEXT_MUTED};
      font-size: 0.8rem;
      user-select: none;
      padding: 8px 0;
      transition: color 120ms ease;
      &:hover { color: ${TEXT}; }
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
      border-top: 1px solid ${BORDER};
      font-size: 0.8rem;

      .name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        color: ${TEXT_MUTED};
      }

      .size {
        flex: none;
        color: ${TEXT_FAINT};
        font-variant-numeric: tabular-nums;
      }

      button {
        flex: none;
        border: 1px solid ${BORDER};
        border-radius: 4px;
        background: ${CONTROL_BG};
        color: ${TEXT};
        padding: 4px 12px;
        font-size: 0.75rem;

        &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }
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
  /**
   * The file list the LINK claims, shown while the swarm is still delivering the real one.
   *
   * Advisory, and treated that way throughout: it is written by whoever built the link, so it can
   * say anything. What keeps that safe is that it never reaches `entries`, which is what the button
   * downloads and which stays bound to engine metadata. The button is disabled until that metadata
   * arrives, so a preview cannot be acted on, only looked at, and by the time anything can be
   * pressed the real list has replaced it on screen.
   */
  preview?: PreviewFile[]
}

const DownloadPage = ({ magnet, selection, preview }: Props) => {
  const { client, snapshot, handle, viewer, claim, engineError, storageFull } = useDownloadTorrent(magnet)

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
  /**
   * What the page SHOWS, which is the real list once there is one and the link's claim until then.
   *
   * Deliberately separate from `entries`. Everything below this line that decides what happens reads
   * `entries`; everything that decides what is drawn reads `shown`. Collapsing the two would let a
   * link's own description of a torrent choose which files get written to somebody's disk.
   */
  const previewEntries: SaveEntry[] = useMemo(() => {
    if (files || !preview?.length) return []
    return resolveSelection(selection, preview.length)
      .filter((index) => preview[index] !== undefined)
      .map((index) => ({ index, path: preview[index]!.path, size: preview[index]!.size }))
  }, [files, preview, selection])

  const showingPreview = !files && previewEntries.length > 0
  const shown = files ? entries : previewEntries
  const totalBytes = shown.reduce((n, e) => n + e.size, 0)

  const torrentName = useMemo(
    () => (magnet ? magnetParam(magnet, 'dn') : undefined)
      ?? files?.[0]?.path.split('/')[0]
      ?? preview?.[0]?.path.split('/')[0]
      ?? 'this torrent',
    [magnet, files, preview],
  )

  const single = entries.length === 1 ? entries[0]! : null
  /* the same question asked of whatever is on screen, so a one-file preview reads as one file */
  const singleShown = shown.length === 1 ? shown[0]! : null
  // libtorrent reports a path relative to the torrent root, so a multi-file release repeats its
  // folder in front of every entry; the folder is already the heading here
  const leaf = (path: string) => path.split('/').pop() || path

  const subjectName = singleShown ? leaf(singleShown.path) : torrentName
  const framed = useMemo(framedByAnotherOrigin, [])
  const openHere = typeof window === 'undefined'
    ? null
    : window.location.origin + window.location.pathname + window.location.search

  const start = useCallback((chosen: SaveEntry[], label: string) => {
    // Called straight from the click with nothing awaited before it: the service worker handshake
    // and the save picker both spend the gesture's transient activation, and an await here loses it.
    if (handle == null || !chosen.length || abortRef.current) return
    /**
     * The click is what starts the transfer, and this is where it starts.
     *
     * Until now the torrent has been sitting on its metadata with every piece at skip, so the swarm
     * has been told nothing about what this page wants. The reads below re-anchor the window as they
     * advance and would eventually plan it themselves, but the first one is behind a sink handshake
     * that can take seconds, and those are seconds of a pressed button with nothing moving.
     */
    claim(chosen[0]!.index)
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
  }, [client, handle, viewer, claim, torrentName])

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
          <div className="glyph">{singleShown ? <FileIcon /> : <Folder />}</div>
          <div className="about">
            <div className="name">{subjectName}</div>
            <div className="meta">
              {shown.length === 0
                ? files
                  ? 'None of the requested files are in this torrent'
                  : 'Reading the torrent from the network'
                : `${getHumanReadableByteString(totalBytes)}${singleShown ? '' : ` · ${shown.length} files`}`}
              {/* said out loud, because until metadata lands this is the link's word and not the
                  torrent's, and the two can disagree */}
              {showingPreview && ' · from the link'}
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

        {/**
          * What the swarm is doing, which is the only explanation of a download that is not moving.
          *
          * Only while one is running. Before the click nothing is being transferred on purpose, and
          * a permanent "0 peers · 0 B/s" under an unpressed button reads as a page that is broken
          * rather than one that is waiting.
          */}
        {busy && !status && (
          <div className="swarm" data-testid="swarm">
            <span className="item"><User />{peers} peers</span>
            <span className="item"><ArrowDown />{getHumanReadableByteString(rate, true)}/s</span>
          </div>
        )}

        {/**
          * Says out loud that arriving here costs nothing, which is the whole point of the hold.
          *
          * Phrased about what OPENING the page did, not about what is on disk: a second visit to the
          * same link finds bytes already cached from the first, and "nothing is downloaded" would be
          * a claim about those.
          */}
        {ready && !busy && !status && !finished && (
          <div className="note">Opening this page downloads nothing. Press the button to start.</div>
        )}

        {shown.length > 1 && (
          <details className="files">
            <summary>{shown.length} files{showingPreview && ' from the link'}</summary>
            <div className="list">
              {shown.map((entry) => (
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
                  {/* no per-file button while this list is the link's claim rather than the
                      torrent's: its indices are the link's too, and `start` writes files to disk by
                      index. Disabling the button would be enough today and would stop being enough
                      the first time somebody loosens `ready`. Not rendering it cannot rot that way. */}
                  {!showingPreview && (
                  <button
                    aria-label={`Download ${leaf(entry.path)}`}
                    onClick={() => start([entry], `Downloading ${leaf(entry.path)}`)}
                    disabled={!ready || busy}
                  >
                    Download
                  </button>
                  )}
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
