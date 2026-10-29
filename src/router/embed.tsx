import type { MediaPlayerSource } from '@banou/media-player'
import type { EmbedMode } from './file-selection'

import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { Activity, ArrowDown, ArrowUp, Download, ExternalLink, Shield, User, Users } from 'lucide-react'
import { MediaPlayer } from '@banou/media-player'
import normalizerWorkletUrl from '@banou/media-player/volume-normalizer-worklet.js?no-inline&url'

import { PAGE_BG, TEXT, VIDEO_SCRIM, VIDEO_TEXT_SHADOW, WARN } from '../theme'
import { getHumanReadableByteString } from '../utils/bytes'
import { isFramed } from '../utils/framed'
import { downloadedByteRanges } from '../torrent/downloaded-ranges'
import { magnetInfoHash } from '../torrent/magnet'
import { snapshotState } from '../torrent/use-torrents'
import { usePlayerTorrent } from '../torrent/use-player-torrent'
import { useReachability } from '../torrent/use-reachability'
import { useGiveToRipple } from '../torrent/use-handover'
import { vpnStatus } from '../torrent/vpn-status'
import { TooltipDisplay } from '../components/tooltip-display'
import DownloadPage from './download'
import { parseFileSelection } from './file-selection'
import { decodeMagnetParam, encodeMagnetParam } from './magnet-codec'
import { NORMALIZE_VOLUME_KEY, normalizeVolumeSaved } from './normalize-volume'
import { keepPlayerVolume } from './player-volume'
import { saveLanguages, savedLanguages, type TrackLanguages } from './track-languages'
import { Route, getRoutePath, getRouterRoutePath } from './path'
import { STATE_LABEL } from './torrent-format'

const playerStyle = css`
  height: 100%;
  width: 100%;
  overflow: hidden;
  /* The player covers this box completely: its own root is opaque and sized 100% by 100%, as is the
     chrome inside it, so the letterbox bars and the frame before the first decode are made of the
     PLAYER's black and not of this rule. This is only the backstop underneath, which is why it can
     be the page grey rather than the black it used to be: nothing here is normally on screen, and
     no colour is allowed to live outside the palette. */
  background: ${PAGE_BG};

  /**
   * The whole top row, drawn by this app rather than by the player.
   *
   * The player will render a \`title\` of its own across the full width, and on a phone that is the
   * problem: the filename ellipsizes against the WHOLE width and then runs underneath the readout
   * painted on top of it, because the two sit in separate layers and neither can see the other. One
   * flex row is the only arrangement where the filename can give way to the numbers, so this app owns
   * both and passes the player no title at all.
   *
   * An overlay item is handed a layer covering the whole picture, so this is ordinary positioning
   * against the video, sized against the player's own unit rather than \`rem\`, which is root relative
   * and belongs to whatever page is embedding this.
   */
  .ripple-overlay-content {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    /* longhands per breakpoint: a shorthand inside a media query is hoisted after the rule above it
       and would silently drop the safe-area inset, which clears a notch in fullscreen */
    padding-top: calc(calc(1.2 * var(--mp-unit)) + env(safe-area-inset-top, 0px));
    /* deeper than the top, and it is not spacing: it is the room the gradient below needs to reach
       transparent. The row's content is centred between the two, so this also keeps the text up in
       the dark end of the fade where it is protected. */
    padding-bottom: calc(3.6 * var(--mp-unit));
    padding-left: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-left, 0px));
    padding-right: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-right, 0px));
    @media (min-width: 768px) {
      padding-top: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(6 * var(--mp-unit));
      padding-left: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-left, 0px));
      padding-right: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-right, 0px));
    }

    display: flex;
    align-items: center;
    gap: calc(1.2 * var(--mp-unit));

    font-weight: 400;
    font-size: calc(1.2 * var(--mp-unit));
    line-height: calc(1.7 * var(--mp-unit));
    @media (min-width: 960px) {
      font-size: calc(1.4 * var(--mp-unit));
      line-height: calc(2 * var(--mp-unit));
    }
    text-shadow: 0 0 4px ${VIDEO_TEXT_SHADOW};
    color: ${TEXT};
    white-space: nowrap;

    /**
     * The wash under this row, and the only one there is.
     *
     * The player draws a scrim of its own at the top, but it hangs off the \`title\` element, and
     * this app deliberately passes no title (see the note on the MediaPlayer below), so it never
     * mounts. That leaves this band plus the per-glyph shadow above as the entire reason the
     * filename, the peer count and an engine failure stay readable over arbitrary footage.
     *
     * The token is a gradient, and it is the player's own, mirrored from the control bar at the
     * other end of the picture. It was a flat fill until somebody had to watch something behind it:
     * a flat band ends on a hard edge, and an edge across a picture reads as a border on the frame,
     * so the eye goes to the line instead of to the video. The two ends of the picture now fade the
     * same way.
     */
    background: ${VIDEO_SCRIM};
  }

  /* The one thing here that may be cut: a release filename is long and its tail is the least of it,
     where a peer count that loses a digit is simply wrong. So this yields the width and nothing else
     does. */
  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;

    font-weight: 500;
    font-size: calc(1.6 * var(--mp-unit));
    line-height: calc(1.9 * var(--mp-unit));
    @media (min-width: 960px) {
      font-size: calc(1.8 * var(--mp-unit));
      line-height: calc(2.2 * var(--mp-unit));
    }
  }

  /* Bytes downloaded is the first thing to go when there is no room: it is the only figure here that
     is also drawn on the seekbar, and the numbers beside it are not repeated anywhere. The status
     text is NOT dropped with it, because "Loading metadata…" and an engine failure are the whole
     explanation of a player that is showing nothing, and a phone is where that matters most. */
  .downloaded {
    display: none;
    @media (min-width: 560px) {
      display: block;
    }
  }

  .loading-information a {
    pointer-events: auto;
    color: inherit;
  }

  /* two sentences, so they wrap rather than push the readouts off the row */
  .loading-information.window-note {
    min-width: 0;
    white-space: normal;
  }

  /*
   * The two links out, in front of everything the torrent is reporting.
   *
   * They belong with the readouts rather than with the filename, so they sit at the head of that
   * side of the row: what you can DO, then what the download is doing. They stay their OWN group
   * rather than joining the readouts, which is what keeps them out of the competition for width.
   * Every figure to their right is as wide as whatever it currently reads, so the readouts shrink
   * against each other, and a link that lost that competition used to be pushed off the right edge
   * where it could not be reached or even seen.
   *
   * ICONS ONLY, with the sentence in the hover. A word beside each glyph bought nothing the tooltip
   * does not say better, and it spent width on the one part of this row that is not information
   * about the video.
   */
  .player-links {
    flex: none;
    pointer-events: auto;
    display: flex;
    align-items: center;
    /* wide enough that the two pills below, which overhang their glyphs by 8px a side, do not touch */
    gap: calc(2.4 * var(--mp-unit));

    .item.link {
      display: flex;
      align-items: center;
      color: inherit;
      text-decoration: none;
      cursor: pointer;

      /*
       * A translucent pill under the cursor, which is the player's own idiom for a pressable control
       * and the only feedback a glyph with no fill can give now that there is no word to underline.
       *
       * The negative margin cancels the padding, so the pill exists without the row growing 8px
       * taller than the readouts beside it.
       */
      /*
       * A 40px target around a 24px glyph, which is the smallest thing in this row anybody has to
       * hit. The negative margin cancels it, so the pill and the hit area both exist without the row
       * growing taller than the readouts beside it.
       */
      padding: 8px;
      margin: -8px;
      border-radius: 4px;
      transition: background-color 120ms ease;

      &:hover,
      &:focus-visible {
        background-color: rgba(255, 255, 255, 0.16);
      }

      /* keyboard users get a ring; the row sits on arbitrary footage, so it carries its own contrast */
      &:focus-visible {
        outline: 2px solid ${TEXT};
        outline-offset: 2px;
      }
    }

    svg {
      flex-shrink: 0;
    }
  }

  /* the slot itself takes no pointer events, so the tooltip anchors ask for them back */
  .media-information {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: calc(1.2 * var(--mp-unit));

    /*
     * THE NUMBERS GIVE WAY FIRST.
     *
     * Every figure here is as wide as whatever it currently reads, and the range is large: a speed
     * runs from 0 B/s to three digits and a unit, and a peer count from one digit to five. Folding
     * the words was enough for the values this was measured at and not for the widest ones, and the
     * way it failed is the part that matters: the row simply overflowed and whatever was last went
     * off the right edge where it could not be reached or even seen. Nothing errored.
     *
     * So the shrinking is aimed rather than left to the default. Allowing an item to go below its
     * content width lets a long speed ellipsize. A truncated speed is still a speed.
     *
     * The two links used to end this row and were the things that got pushed off it. They are at the
     * head of the row now, outside this group and outside the competition entirely, which is a
     * better answer than pinning them was. The pin below stays because it is written against what an
     * item IS rather than against a list of ids, so anything pressable dropped in here later is
     * already covered.
     */
    min-width: 0;

    /*
     * The rules go on the ANCHOR, which is what is actually laid out here.
     *
     * Every item in this row is wrapped by TooltipDisplay in a div of its own carrying
     * data-tooltip-id, so the flex children of this row are those wrappers and not the items inside
     * them. Three passes of shrink rules written against .item changed the measured overflow by
     * exactly zero pixels, which is the tell: a rule that has no effect at all is usually on the
     * wrong element rather than the wrong property.
     *
     * The chain needs min-width at every level, because a flex item's automatic minimum is its own
     * content: leave it out anywhere and everything below is pinned to the text it is refusing to
     * shrink for.
     */
    > [data-tooltip-id] {
      min-width: 0;
    }

    /* whatever is pressable holds its size, matched on what it IS rather than on a list of ids that
       the next one added here would have to be remembered into; and so does the peer count, which is
       wrong once it loses a digit */
    > [data-tooltip-id]:has(.item.link),
    > [data-tooltip-id]:has(.item.state),
    > [data-tooltip-id]:has(.item.count) {
      flex-shrink: 0;
    }

    /* the figure needed least while watching, and the one a phone has no room for: measured at 360
       to 412px, the peer count and both speeds were cut with it there */
    > [data-tooltip-id='upload-speed'] {
      display: none;
      @media (min-width: 480px) {
        display: block;
      }
    }

    .item {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;

      span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    /* an icon never shrinks: it is the whole label once the words fold */
    svg {
      flex-shrink: 0;
    }

    /*
     * Only the states worth acting on take a colour.
     *
     * A green tick on every healthy playback would be one more permanently lit thing over the
     * picture, and this row sits on top of somebody's video. On reads in the same text as the peer
     * count beside it; off and reconnecting are the ones that explain a player showing nothing, so
     * they are the ones allowed to stand out. The WORD differs in all three cases either way.
     */
    .item.vpn[data-state='off'],
    .item.vpn[data-state='healing'] {
      color: ${WARN};
    }

    /*
     * The WORDS go when the row runs out of room, never the icons.
     *
     * Same threshold and same reasoning as the downloaded counter above: on a phone this row is
     * competing with the filename, and an icon still says which one is which where a truncated word
     * does not. The tooltip carries the full sentence at every width.
     *
     * Three items fold, and the VPN one is here for a reason worth writing down. Its label is the
     * WIDEST thing in the row and it is only wide TRANSIENTLY: VPN On measures 72px and
     * VPN Reconnecting about 140, which is exactly the state a player is in while it starts. So the
     * row fit every time it was measured settled and overflowed by 35px when measured during
     * startup, with the two links pushed off the right edge where nobody can press them. Folding the
     * word costs nothing that is not already said twice: the icon keeps its colour, which is what
     * carries off and reconnecting, and the tooltip carries the sentence.
     *
     * The torrent state folds with them for the plainer reason that Downloading is the longest word
     * in the row, with Retrying not far behind. The peer count folds its two words and keeps both
     * numbers, which are the readout.
     */
    .item.state span,
    .item.vpn span,
    .item.count .word {
      display: none;
      @media (min-width: 560px) {
        display: inline;
      }
    }
  }
`

// the owner's wording, 2026-10-19, and the one notice that says how something works: only a file playing
// through a window in a frame shows it, since at the top level the page is already Ripple's
const WINDOW_NOTE = 'Too big to download ahead here, so it streams as you watch. In Ripple (header link), with more room allowed, it can download in full, without next episode, tracking or watch together.'

const Player = () => {
  const [searchParams] = useSearchParams()
  const { fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  /**
   * Both parameters, because this is the SECOND of two decode sites and they have to agree: the
   * other is in `Embed` below. Reading `m` here and only `magnet` there would render an empty player
   * for every packed watch link while download links kept working.
   *
   * decodeMagnetParam never throws. It is fed embedder-written text, and a bare atob lands its
   * exception during render on the default route, taking the whole page down rather than showing an
   * empty player.
   */
  const magnet = useMemo(() => decodeMagnetParam(searchParams), [searchParams])
  // parsed as /download parses it, so the two routes agree on what a link names. With no file
  // named, the hook plays the torrent's video file.
  const named = useMemo(() => {
    const selection = parseFileSelection(null, _fileIndex)
    return selection.kind === 'single' ? selection.index : undefined
  }, [_fileIndex])
  const { snapshot, engineError, storageFull, fileIndex, read, readQuiet, prioritizeFrom } = usePlayerTorrent(magnet, named)
  const [normalizeVolume, setNormalizeVolume] = useState(() => normalizeVolumeSaved((k) => localStorage.getItem(k)))
  const chooseNormalizeVolume = (on: boolean) => {
    setNormalizeVolume(on)
    try { localStorage.setItem(NORMALIZE_VOLUME_KEY, on ? '1' : '0') } catch {}
  }
  const [languages, setLanguages] = useState(() => savedLanguages((k) => localStorage.getItem(k)))
  const chooseLanguage = (picked: TrackLanguages) => {
    setLanguages((current) => ({ ...current, ...picked }))
    saveLanguages((k, v) => localStorage.setItem(k, v), picked)
  }
  // The player keeps no volume of its own: it writes it onto its <video> and reads it back from there, and in
  // local mode that element is rendered on the first commit, so it is already here.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const video = box.current?.querySelector('video')
    return video ? keepPlayerVolume(video) : undefined
  }, [])
  /**
   * Whether anything is carrying peer traffic, drawn beside the peer count it explains.
   *
   * A player with the tunnel down shows "Loading metadata…" and zero peers forever, which is exactly
   * what a torrent nobody is seeding looks like. One of those is worth waiting out and the other is
   * not, and until this readout existed the picture was identical.
   */
  const vpn = vpnStatus(useReachability())

  // Track menus, thumbnails and the playback controller all live in the player now, so none of the
  // state that used to mirror them is here any more.

  const selectedFile = snapshot?.files?.files[fileIndex]
  const fileSize = selectedFile?.size
  // libtorrent reports a path relative to the torrent root, so a multi-file release carries its
  // folder in front of every entry. The player has one line for a filename and the folder repeats
  // the release name that is usually already in the app around it, so only the last segment shows.
  const fileName = selectedFile?.path.split('/').pop() || undefined

  const origin = useMemo(() => new URL(window.location.toString()).origin, [])
  const publicPath = useMemo(() => new URL(import.meta.env.DEV ? '/build/' : '/', origin).toString(), [origin])

  const libavWorkerUrl = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/libav-worker.js`, origin).toString(),
    [origin]
  )

  // jassub 2's worker is an ES module that the bundler has to build, so it comes out of its own build
  // pass into build/jassub rather than being copied. See vite.jassub.config.ts. The blob that used to
  // wrap it in importScripts is gone: a module worker cannot host one, and v2 asks for `type: module`
  // on both of its branches whatever the caller passes.
  const jassubBase = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub/`, origin).toString(),
    [origin]
  )
  const jassubWorkerUrl = useMemo(() => new URL('worker.js', jassubBase).toString(), [jassubBase])
  const jassubWasmUrl = useMemo(() => new URL('jassub-worker-modern.wasm', jassubBase).toString(), [jassubBase])
  // Now worth passing, which it was not before: jassub 2 picks the modern build on RELAXED simd
  // rather than plain simd, so the fallback covers current browsers and not only ancient ones.
  const jassubLegacyWasmUrl = useMemo(() => new URL('jassub-worker.wasm', jassubBase).toString(), [jassubBase])
  const defaultFontUrl = useMemo(() => new URL('default.woff2', jassubBase).toString(), [jassubBase])
  const cjkFontUrl = useMemo(() => new URL('noto-sans-jp.otf', jassubBase).toString(), [jassubBase])

  const st = snapshot?.status
  const info = {
    peers: st?.numPeers ?? 0,
    downloadSpeed: snapshot?.displayDownloadRate ?? 0,
    uploadSpeed: st?.uploadRate ?? 0,
  }
  // the whole swarm per the trackers, never fewer than are connected (a tracker that does not carry the
  // hash answers 0 and 0); until one answers with both counts, and on a magnet with none, the
  // connected peers stand in
  const swarm = st && st.swarmSeeds >= 0 && st.swarmPeers >= 0
    ? { seeders: Math.max(st.swarmSeeds, st.numSeeds), leechers: Math.max(st.swarmPeers, st.numPeers - st.numSeeds) }
    : null
  const downloads = snapshot?.swarmDownloads ?? -1

  const hasMetadata = Boolean(snapshot?.files)
  const downloaded = snapshot?.status?.totalDone ?? 0

  // This page's own URL, opened as a tab of its own: first party, so it gets Ripple's storage rather
  // than the separate 10 GiB Firefox gives a frame inside another site's page.
  const watchHref = useMemo(() => {
    const query = new URLSearchParams(searchParams)
    if (selectedFile) query.set('fileIndex', String(fileIndex))
    return new URL(`${getRouterRoutePath(Route.WATCH)}?${query.toString()}`, origin).toString()
  }, [searchParams, origin, selectedFile, fileIndex])

  // Why there is nothing to watch yet, or null once there is. Kept apart from the byte counter
  // because only the counter is dropped when the row runs out of room.
  //
  // A full origin outranks the metadata line and survives past it: the file being watched cannot
  // finish, so playback stops wherever it is, and without this the player just stops with no
  // explanation anywhere. Ripple reclaims what it can on its own first, so seeing this at all means
  // the space is held by torrents the user added themselves, or, in a frame, whose storage holds
  // nothing else, that the file is too big for it.
  const status = engineError
    ?? (storageFull && isFramed()
      ? <>Too big for this browser's storage here. <a href={watchHref} target="_blank" rel="noopener noreferrer">Open it in Ripple</a> to play it.</>
      : null)
    ?? (storageFull ? 'Out of storage space. Remove a download in Ripple to free room.' : null)
    ?? (hasMetadata ? null : 'Loading metadata…')
    ?? (snapshot?.windowed && isFramed() ? WINDOW_NOTE : null)
  // Byte spans, not fractions: the player maps them onto the timeline through the keyframe index,
  // because a file's download percentage is not its playback percentage.
  const downloadedRanges = useMemo(
    () => downloadedByteRanges(snapshot, fileIndex)
      .map(([startByteOffset, endByteOffset]) => ({ startByteOffset, endByteOffset })),
    [snapshot, fileIndex],
  )

  // Typed as the union rather than spread inline: a conditional spread widens to "maybe read, maybe
  // size", which is neither arm, and both halves have to travel together.
  const source: MediaPlayerSource = fileSize ? { read, size: fileSize } : {}

  /*
   * What the engine is doing with the torrent, which is not the same question as what the player is
   * doing with the file.
   *
   * The row already says why there is nothing to watch YET, and how many bytes have landed. Neither
   * answers "is this still downloading", and the two look identical from the outside once playback
   * starts: a torrent that finished and is now seeding, and one still fetching ahead of the
   * playhead, both play. Read through the same `snapshotState` and `STATE_LABEL` the library rows
   * use, so a player and a row never disagree about a word.
   */
  const stateLabel = snapshot ? STATE_LABEL[snapshotState(snapshot)] : null

  /*
   * The two ways out of an embedded player, and the reason they exist.
   *
   * This component is usually running inside somebody else's page, where the person watching has no
   * address bar for it and no other route to the torrent: not to the rest of its files, not to the
   * download page, not to Ripple. Both open in a NEW TAB, because navigating the frame would replace
   * the embedder's player with a page they did not ask for. Ripple's tab keeps this page as its
   * opener, to take what this player downloaded (`use-handover.ts`); the download page gets no handle.
   *
   * Absolute, built from this document's own origin rather than left relative: the href is read by an
   * embedder's page in some contexts, and a bare path there resolves against THEIR origin.
   */
  // an INFO HASH, never the row id: a row id is a libtorrent handle and names a different torrent
  // in the next engine, so a link carrying one would open whatever got that number later
  const infoHash = useMemo(() => (magnet ? magnetInfoHash(magnet) : null), [magnet])
  useGiveToRipple(infoHash)
  const libraryHref = useMemo(
    () => (magnet && infoHash
      ? new URL(getRoutePath(Route.HOME, { torrent: infoHash, magnet: encodeMagnetParam(magnet) }), origin).toString()
      : null),
    [magnet, infoHash, origin],
  )

  /*
   * This page's own URL under the other PATH, rather than a link built from scratch.
   *
   * That conversion is the one `EmbedOptions` describes: /watch and /download take the same query,
   * so swapping the path downloads what this URL was playing. Doing it this way carries the file
   * being watched across for free, keeps whichever magnet encoding the embedder used rather than
   * re-packing it, and needs no metadata, so the link is right from the first paint instead of
   * appearing once the file list lands. `embedPath` cannot do it: in download mode it writes a
   * `files` selection and drops `fileIndex`, so it would need a file COUNT this page may not have
   * yet. Once the file being played is known it is written in, so a link that named none downloads
   * the file the button names rather than the whole release.
   */
  const downloadHref = useMemo(() => {
    if (!magnet) return null
    const query = new URLSearchParams(searchParams)
    if (selectedFile) query.set('fileIndex', String(fileIndex))
    return new URL(`${getRouterRoutePath(Route.DOWNLOAD)}?${query.toString()}`, origin).toString()
  }, [magnet, searchParams, origin, selectedFile, fileIndex])

  const overlay = (
    <div className="ripple-overlay-content">
      {/* always rendered, empty or not: it is what takes the width the rest of the row leaves */}
      <div className="file-name">{fileName}</div>
      {/* The way back to the whole torrent, and to its files. At the head of the row, and drawn as
          glyphs alone: the tooltip carries the sentence, which is more than a one word label said. */}
      <div className="player-links">
        {libraryHref && (
          <TooltipDisplay
            id="open-in-ripple"
            /* end aligned, like every readout to the right of them: these sit in the right half of
               the row now, so a chip anchored to its start would grow towards the edge it is nearest. */
            tooltipPlace="bottom-end"
            text={
              <a
                className="item link"
                href={libraryHref}
                target="_blank"
                rel="opener"
                data-testid="open-in-ripple"
                /* The glyph carries no text, and react-tooltip never wires aria-describedby, so the
                   tooltip is invisible to a screen reader. The name has to be stated. */
                aria-label="Open this torrent in Ripple"
              >
                <ExternalLink />
              </a>
            }
            toolTipText={<span>Open this torrent in Ripple</span>}
          />
        )}
        {downloadHref && (
          <TooltipDisplay
            id="open-download-page"
            tooltipPlace="bottom-end"
            text={
              <a
                className="item link"
                href={downloadHref}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="open-download-page"
                aria-label={`Download ${fileName ?? 'this torrent'}`}
              >
                <Download />
              </a>
            }
            toolTipText={<span>Download {fileName ?? 'this torrent'}</span>}
          />
        )}
      </div>
      {/* once the engine errors nothing will ever arrive, so say that instead of spinning forever */}
      {status
        ? <div className={status === WINDOW_NOTE ? 'loading-information window-note' : 'loading-information'}>{status}</div>
        : <div className="downloaded">Downloaded {getHumanReadableByteString(downloaded)}</div>}
      <div className="media-information" data-testid="media-information">
        {stateLabel && (
          <TooltipDisplay
            id="torrent-state"
            tooltipPlace="bottom-end"
            text={<div className="item state" data-testid="torrent-state"><Activity /><span>{stateLabel}</span></div>}
            toolTipText={<span>Torrent: {stateLabel}</span>}
          />
        )}
        {vpn && (
          <TooltipDisplay
            id="vpn"
            /* The row is at the TOP of the picture, so a chip placed above it has nowhere to go and
               floating-ui rescues it by flipping to the SIDE, which lands the two rightmost chips
               150 to 220px away from the item they belong to. Naming the placement it would flip to
               anyway keeps every chip under its own item. */
            tooltipPlace="bottom-end"
            text={<div className="item vpn" data-state={vpn.state}><Shield /><span>VPN {vpn.label}</span></div>}
            toolTipText={<span>VPN: {vpn.label}</span>}
          />
        )}
        <TooltipDisplay
          id="peers"
          tooltipPlace="bottom-end"
          text={swarm
            ? (
              <div className="item count" data-testid="peers">
                <Users />
                <span>{swarm.seeders}<span className="word"> seeder{swarm.seeders === 1 ? '' : 's'}</span> · {swarm.leechers}<span className="word"> leecher{swarm.leechers === 1 ? '' : 's'}</span></span>
              </div>
            )
            : <div className="item count" data-testid="peers"><User /><span>{info.peers}</span></div>}
          toolTipText={swarm
            ? (
              <span>
                Seeders: {swarm.seeders}<br />
                Leechers: {swarm.leechers}<br />
                {downloads >= 0 && <>Downloads: {downloads}<br /></>}
                Connected peers: {info.peers}
              </span>
            )
            : <span>Peers: {info.peers}</span>}
        />
        <TooltipDisplay
          id="download-speed"
          tooltipPlace="bottom-end"
          text={<div className="item"><ArrowDown /><span>{getHumanReadableByteString(info.downloadSpeed, true)}/s</span></div>}
          toolTipText={<span>Download speed: {getHumanReadableByteString(info.downloadSpeed)}/s</span>}
        />
        <TooltipDisplay
          id="upload-speed"
          tooltipPlace="bottom-end"
          text={<div className="item"><ArrowUp /><span>{getHumanReadableByteString(info.uploadSpeed, true)}/s</span></div>}
          toolTipText={<span>Upload speed: {getHumanReadableByteString(info.uploadSpeed)}/s</span>}
        />
        {/* audio and subtitle pickers live in the player's own settings menu now */}
      </div>
    </div>
  )

  return (
    <div css={playerStyle} ref={box}>
      <MediaPlayer
        {...source}
        // Served to whoever frames this page, and only them, through @banou/media-player/remote: a
        // watch-together host's followers are made to match this player through it. A tab that opens
        // the embed directly has nobody to serve.
        expose

        // No `title`: the player would draw it full width in a layer of its own, where it cannot see
        // the readout above it and runs underneath it on a narrow screen. The overlay row below
        // carries the filename instead, in the same flex line as the numbers it has to give way to.
        publicPath={publicPath}
        libavWorkerUrl={libavWorkerUrl}
        jassubWorkerUrl={jassubWorkerUrl}
        jassubWasmUrl={jassubWasmUrl}
        jassubLegacyWasmUrl={jassubLegacyWasmUrl}
        defaultFontUrl={defaultFontUrl}
        cjkFontUrl={cjkFontUrl}
        normalizerWorkletUrl={normalizerWorkletUrl}
        normalizeVolume={normalizeVolume}
        onNormalizeVolumeChange={chooseNormalizeVolume}
        preferredAudioLanguage={languages.audio}
        preferredSubtitleLanguage={languages.subtitles}
        onPreferredAudioLanguageChange={(audio) => chooseLanguage({ audio })}
        onPreferredSubtitleLanguageChange={(subtitles) => chooseLanguage({ subtitles })}
        autoplay={true}
        overlay={overlay}
        downloadedRanges={downloadedRanges}
        // A non-prioritising, fail-fast reader: generating previews walks the whole file, and sharing
        // playback's reader would let it steal download order from the bytes playback is blocked on.
        thumbnailRead={readQuiet}
        onSeek={(fraction) => { if (fileSize) prioritizeFrom(fraction * fileSize) }}
      />
    </div>
  )
}

/**
 * The two things this component can be, chosen by the ROUTE that mounted it.
 *
 * /watch is the player and /download is the download page, and both take the same query, so an
 * embedder holding one URL for a release gets the other by swapping the path. Nothing in the query
 * can change that: a `mode` parameter used to, and is now neither written nor read.
 *
 * The two are separate COMPONENTS, not two branches inside one, so neither mounts the other's hooks:
 * the player would otherwise register a playback viewer with its own read-window cache behind a page
 * that never plays anything.
 */
const Embed = ({ mode = 'watch' }: { mode?: EmbedMode } = {}) => {
  const [searchParams] = useSearchParams()
  const magnet = useMemo(() => decodeMagnetParam(searchParams), [searchParams])
  const selection = useMemo(
    () => parseFileSelection(searchParams.get('files'), searchParams.get('fileIndex')),
    [searchParams],
  )
  /**
   * The link's own description of the torrent, for the download page to show until the swarm sends
   * the real one. Undefined for anything unreadable, which is the same as it never being there.
   */

  if (mode === 'download') return <DownloadPage magnet={magnet} selection={selection} />
  return <Player />
}

export default Embed
