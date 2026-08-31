import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'
import { Link } from 'react-router-dom'

import {
  BORDER,
  BORDER_INTERACTIVE,
  BORDER_STRONG,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  DANGER,
  EMPHASIS,
  EMPHASIS_HOVER,
  FOCUS_RING,
  OK,
  PAGE_BG,
  SUNKEN_BG,
  SURFACE_BG,
  TEXT,
  TEXT_FAINT,
  TEXT_MUTED,
  TEXT_ON_LIGHT,
} from '../theme'
import { ArrowDown, Download, File as FileIcon, Folder, Link2, Play, User } from 'react-feather'

import type { SaveEntry } from '../torrent/save-file'
import type { FileSelection } from './file-selection'
import {
  DownloadUnavailableError,
  isSaveCancelled,
  saveTorrentEntriesAsZipToDisk,
  saveTorrentFileToDisk,
} from '../torrent/save-file'
import { useDownloadTorrent } from '../torrent/use-download-torrent'
import { useReachability } from '../torrent/use-reachability'
import { getHumanReadableByteString } from '../utils/bytes'
import { VpnStat } from '../components/vpn-stat'
import { canOfferWatch, pickVideoFile } from '../torrent/watch'
import { magnetInfoHash, magnetParam } from '../torrent/magnet'
import { torrentFileFor } from '../torrent/torrent-export'
import { hint } from '../components/hint'
import { useThumbnail, useThumbnailGeneration } from '../torrent/use-thumbnails'
import { embedPath } from './embed-link'
import { resolveSelection } from './file-selection'

const style = css`
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
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

  /**
   * The way back into the app, and the same bar the library has.
   *
   * This page is reached from a link somebody was handed, so for a lot of the people who see it this
   * is the ONLY ripple page they have ever loaded, and until now it named the app without saying it
   * was one you could go and use. The wordmark is the whole navigation: there is one destination.
   */
  > header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 18px;
    padding: 10px 18px;
    /* opaque and edged, exactly as the library's header is: the card scrolls under it */
    background: ${SURFACE_BG};
    border-bottom: 1px solid ${BORDER};
  }

  /* Centred inside the card before, where it was a caption. In the bar it is the brand and the link,
     so it sits at the top text tier and brightens under the cursor like every other link here. */
  .wordmark {
    font-size: 1.2rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    color: ${TEXT};
    transition: opacity 120ms ease;

    &:hover { opacity: 0.75; }
  }

  /* Grows to whatever is left, so a short card sits in the middle of the page and a tall one simply
     makes the page scroll rather than being clipped at the top. */
  > main {
    flex: 1;
    display: flex;
    padding: 24px 16px;
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

    /* A frame of the release fills the tile it replaces, cropped rather than letterboxed: the tile is
       square and a video frame is not, and a picture the same size as the glyph says more than a
       correctly proportioned thumbnail too small to make anything out. */
    .glyph.poster {
      overflow: hidden;
      padding: 0;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
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

  /*
   * The SECOND action, and deliberately not a second primary one.
   *
   * Downloading is what this page is for and what the link asked for, so it keeps the filled button.
   * Watching is an alternative somebody may not have known they had, which is worth offering and not
   * worth competing with the thing they came here to do. Outlined, full width under the primary, so
   * it reads as the same decision rather than as a control belonging to something else.
   */
  .watch {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px 20px;
    border: 1px solid ${BORDER_STRONG};
    border-radius: 6px;
    background: ${CONTROL_BG};
    color: ${TEXT};
    font-size: 0.9rem;
    font-weight: 700;
    text-decoration: none;

    svg { width: 17px; height: 17px; }

    &:hover { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_INTERACTIVE}; }
    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 2px; }
  }

  /*
   * The two things somebody can take away from this page besides the files.
   *
   * Side by side and quieter than the download button, because neither is what the page is for: they
   * are for the person who wants the torrent itself, to seed it elsewhere or to keep the link. Equal
   * width so neither reads as the primary of the two.
   */
  .share {
    display: flex;
    gap: 8px;

    button {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 12px;
      border: 1px solid ${BORDER};
      border-radius: 6px;
      background: ${CONTROL_BG};
      color: ${TEXT};
      font-size: 0.8rem;
      font-weight: 700;

      svg { width: 15px; height: 15px; flex: none; }
      span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }
      &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 2px; }
      &:disabled { opacity: 0.55; }
    }
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
  /**
   * Which files the link asked for, as a grammar rather than a list.
   *
   * Nothing here describes the torrent: `all` when the link said nothing, and otherwise the indices
   * it named. What those indices MEAN is resolved against engine metadata once it lands, so a link
   * can ask for files and can never assert what they are.
   */
  selection: FileSelection
}

const DownloadPage = ({ magnet, selection }: Props) => {
  const { client, snapshot, handle, viewer, claim, engineError, storageFull } = useDownloadTorrent(magnet)
  /**
   * Whether anything is carrying peer traffic, which is the one explanation this page never had.
   *
   * A link opened with the tunnel down sits on "Loading torrent…" with a disabled button and no
   * error text anywhere, and the page is the whole of what that person can see: they have no library
   * strip to check and usually no idea ripple has a transport at all.
   */
  const reachable = useReachability()

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
  /*
   * The page shows what the ENGINE reports and nothing else, so there is one list rather than two.
   *
   * A link used to be able to carry its own copy of the file list, drawn while the swarm delivered
   * the real one. It was advisory, it could say anything, and keeping it safe meant a second list
   * that everything drawing had to read and nothing acting on could. It also cost 38 per cent of a
   * single-file link to add a file extension. Until metadata lands the page now says so, which is
   * what it already said whenever the sender only had a magnet.
   */
  const totalBytes = entries.reduce((n, e) => n + e.size, 0)

  /*
   * `||` throughout rather than `??`, and spelled out rather than chained.
   *
   * A path of "" or "/x" splits to an EMPTY STRING, which `??` accepts as a real answer, so the card
   * would head itself with nothing at all. A path arriving from the engine is not attacker written,
   * but the magnet's display name is, so the guard stays.
   *
   * Written as statements because mixing `??` and `||` in one chain is a syntax error, and the
   * version of this that tried it parsed as nothing and took out every module importing this file.
   */
  const torrentName = useMemo(() => {
    const fromMagnet = magnet ? magnetParam(magnet, 'dn') : undefined
    const fromFiles = files?.[0]?.path.split('/')[0]
    return fromMagnet || fromFiles || 'this torrent'
  }, [magnet, files])

  const single = entries.length === 1 ? entries[0]! : null

  const infoHash = useMemo(() => (magnet ? magnetInfoHash(magnet) ?? undefined : undefined), [magnet])

  /*
   * A picture of the release instead of a file glyph.
   *
   * Narrowed to THIS torrent: the page is usually an embed on somebody else's site showing one
   * release, and reading the visitor's whole library to draw one picture is not its business.
   *
   * It cannot appear before the button is pressed, and that is deliberate rather than a gap. A frame
   * is made from the file's first bytes, and this page writes NOTHING until somebody asks it to,
   * which `embed-download.spec.ts` measures with a positive control. So the picture shows when there
   * is one already on the device, and otherwise arrives once a download is under way and the head
   * has landed. `considerThumbnails` only ever reads bytes that already exist, so mounting this
   * cannot start a transfer.
   */
  useThumbnailGeneration(client, infoHash)
  const poster = useThumbnail(infoHash)

  /*
   * The two ways to take the torrent itself away, rather than its files.
   *
   * `share` is one piece of state for both, so a message from one replaces the other's rather than
   * stacking two lines under the buttons.
   */
  const [share, setShare] = useState<string | null>(null)
  const [savingTorrent, setSavingTorrent] = useState(false)
  const shareTimer = useRef<number | undefined>(undefined)
  const say = useCallback((message: string) => {
    setShare(message)
    window.clearTimeout(shareTimer.current)
    shareTimer.current = window.setTimeout(() => setShare(null), 4_000)
  }, [])
  useEffect(() => () => window.clearTimeout(shareTimer.current), [])

  const copyMagnet = useCallback(() => {
    if (!magnet) return
    // A cross-origin frame can be refused the clipboard outright, and the refusal is the whole
    // outcome from where the person is sitting, so it is said rather than swallowed.
    navigator.clipboard.writeText(magnet)
      .then(() => say('Magnet copied'))
      .catch(() => say('This page was not allowed to use the clipboard'))
  }, [magnet, say])

  /*
   * The .torrent is REBUILT rather than fetched, because there is nothing to fetch.
   *
   * A magnet carries an infohash and the engine gets the rest from the swarm, so afterwards the info
   * dictionary lives only inside libtorrent, which exposes no way to read it back. `torrentFileFor`
   * takes it out of the resume blob, which libtorrent is already asked to write with `save_info_dict`.
   * Nothing here touches torrent storage, so a page that has deliberately written nothing still has.
   */
  const saveTorrentFile = useCallback(() => {
    if (!magnet || !infoHash || savingTorrent) return
    setSavingTorrent(true)
    void torrentFileFor({ infoHash, magnet, flush: () => client.flushResume() })
      .then((bytes) => {
        if (!bytes) { say('The metadata has not arrived yet, so there is no .torrent to save'); return }
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-bittorrent' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${torrentName}.torrent`
        document.body.appendChild(link)
        link.click()
        link.remove()
        // revoked on a later task: revoking in the same one races the navigation the click started
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
        say('Saved the .torrent')
      })
      .catch(() => say('The .torrent could not be built'))
      .finally(() => setSavingTorrent(false))
  }, [magnet, infoHash, savingTorrent, client, torrentName, say])

  /*
   * Whether this torrent has anything to watch, asked of the files the LINK named rather than of the
   * whole torrent: a link for the subtitles of a release should not offer to play the video it did
   * not ask for.
   *
   * `pickVideoFile` reads `name` and `size`, and an engine path is a full path, so the entries are
   * mapped rather than passed through. Its index is a position in THAT array, so it is turned back
   * into the engine's own index before it can name a file.
   */
  const watchable = useMemo(() => {
    if (!files || !entries.length) return null
    const named = entries.map((entry) => ({ name: entry.path, size: entry.size }))
    // `canOfferWatch` also answers true for an UNKNOWN list, which cannot happen here: `named` is
    // built from entries and the guard above requires at least one
    if (!canOfferWatch(named)) return null
    const chosen = entries[pickVideoFile(named)]
    return chosen ?? null
  }, [files, entries])

  const watchHere = useMemo(() => {
    if (!magnet || !watchable) return null
    // null when the magnet cannot be encoded at all, which is the same answer as having no link
    return embedPath({ magnet, mode: 'watch', fileIndex: watchable.index })
  }, [magnet, watchable])

  // libtorrent reports a path relative to the torrent root, so a multi-file release repeats its
  // folder in front of every entry; the folder is already the heading here
  const leaf = (path: string) => path.split('/').pop() || path
  /* named only when there is a choice to have got wrong; a single file needs no restating */
  const watchLabel = watchable && entries.length > 1 ? `Watch ${leaf(watchable.path)}` : 'Watch'

  const subjectName = single ? leaf(single.path) : torrentName
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
      <header>
        {/**
          * Opened in a new tab when somebody else's page is framing this one, because navigating
          * here would replace the download card with the whole library INSIDE their layout, which is
          * not a place ripple should put itself. Unframed it is an ordinary in-app navigation, so
          * the engine and anything it is running survive the trip.
          */}
        <Link className="wordmark" to="/" target={framed ? '_blank' : undefined} rel={framed ? 'noreferrer' : undefined}>
          Ripple
        </Link>
        <VpnStat reachable={reachable}/>
      </header>

      <main>
        <div className="card">
          <div className="subject">
            <div className={'glyph' + (poster ? ' poster' : '')}>
              {poster
                ? <img src={poster} alt="" />
                : single ? <FileIcon /> : <Folder />}
            </div>
            <div className="about">
              <div className="name">{subjectName}</div>
              <div className="meta">
                {entries.length === 0
                  ? files
                    ? 'None of the requested files are in this torrent'
                    : 'Reading the torrent from the network'
                  : `${getHumanReadableByteString(totalBytes)}${single ? '' : ` · ${entries.length} files`}`}
              </div>
            </div>
          </div>

          <button className="cta" onClick={() => start(entries, 'Downloading')} disabled={!ready || busy}>
            {!busy && <Download />}
            {label}
          </button>

          {/**
            * Offered only once the ENGINE has said there is something to play.
            *
            * Not from the link, which says nothing about the files, and not while a download is
            * running, where the two would compete for the same bytes and the same screen. The file
            * it opens is the largest video among the ones this link asked for, which is the same
            * rule the library row uses, so a season pack opens on an episode rather than on a
            * sample.
            */}
          {watchHere && !busy && (
            <Link className="watch" to={watchHere}>
              <Play />
              {watchLabel}
            </Link>
          )}

          {/* Offered whenever there is a magnet at all, which is before metadata: copying a link
              never needed the swarm, and Save says for itself when the metadata has not landed. */}
          {magnet && (
            <div className="share">
              <button type="button" onClick={copyMagnet} {...hint('Copy this torrent\'s magnet link')}>
                <Link2 />
                <span>Copy magnet</span>
              </button>
              <button type="button" onClick={saveTorrentFile} disabled={savingTorrent || !infoHash} {...hint('Save the .torrent file for this torrent')}>
                <FileIcon />
                <span>{savingTorrent ? 'Building…' : 'Save .torrent'}</span>
              </button>
            </div>
          )}
          {share && <div className="note" data-testid="share-note">{share}</div>}

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
      </main>
    </div>
  )
}

export default DownloadPage
