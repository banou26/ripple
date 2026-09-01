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
import { ArrowDown, Check, Download, File as FileIcon, Folder, Link2, Play, User } from 'react-feather'

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
import { saveTorrentFile } from '../torrent/torrent-export'
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

    /* Above the scroller rather than inside it, so they stay reachable partway down a pack.
       Carries no size of its own: the card's own subject line already states the SELECTION's size,
       and the two sat four rows apart saying the same thing in every state, down to "0 bytes". */
    .bulk {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 8px;

      button {
        border: 1px solid ${BORDER};
        border-radius: 4px;
        background: ${CONTROL_BG};
        color: ${TEXT};
        padding: 3px 10px;
        font-size: 0.75rem;

        &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }
        &:disabled { opacity: 0.5; }
      }
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

      /* The tick and the name are ONE target, and the row's own button is deliberately outside it:
         a label wrapping the whole row would make every press of Download toggle the tick as well,
         which is the kind of thing that only shows up as a wrong file in somebody's archive. */
      .pick {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
      }

      /* Native checkbox, so leaving the accent out does not make it neutral: under color-scheme dark
         the UA paints a checked box in the platform accent, usually blue. Same reasoning, and the
         same value, as the add dialog's file list. */
      input {
        accent-color: ${EMPHASIS};
        flex: none;
        margin: 0;
      }

      .name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        color: ${TEXT_MUTED};
      }

      /* The strike is what carries the meaning, so the colour only steps down rather than fading
         out: this row is the point of the list, it says what you are NOT taking. */
      &.off .name { color: ${TEXT_FAINT}; text-decoration: line-through; }

      .size {
        flex: none;
        color: ${TEXT_FAINT};
        font-variant-numeric: tabular-nums;
      }

      /* What already landed, and what is landing now. Both live in one slot so a row never grows a
         second column, and both are words rather than a glyph alone: a tick beside a file name is
         read as "selected" at least as often as "saved". */
      .mark {
        flex: none;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.72rem;
        font-weight: 700;
        color: ${TEXT_FAINT};

        svg { width: 12px; height: 12px; }
      }

      .mark.saved { color: ${OK}; }

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
type Job = {
  fraction: number
  label: string
  total: number
  /** The engine indices this job is reading, so its rows can say so and the plan can keep them. */
  indices: number[]
} | null

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
  const { client, snapshot, handle, viewer, claim, release, engineError, storageFull } = useDownloadTorrent(magnet)
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
  /** Engine indices this page has already written to disk, so the list can say so. */
  const [saved, setSaved] = useState<ReadonlySet<number>>(() => new Set())
  const abortRef = useRef<AbortController | null>(null)
  /**
   * Whether this page is still on screen when a job finally settles.
   *
   * An export is aborted on unmount and its promise settles a turn LATER, by which time the hook has
   * already handed every claim back. Registering a held claim after that would recreate a viewer
   * nothing will ever remove, and a torrent with a viewer is one the storage budget may not reclaim,
   * so the leak is a torrent that can never be evicted rather than a stray message.
   */
  const mounted = useRef(true)

  const files = snapshot?.files?.files
  const indices = useMemo(() => resolveSelection(selection, files?.length ?? 0), [selection, files?.length])

  /**
   * What the LINK puts on the table, which is not the same as what is being taken.
   *
   * Pad files are dropped here rather than further down: they are zeroes a v2 or hybrid torrent
   * inserts to push the next file onto a piece boundary, and a list somebody ticks through, a size
   * total and an archive are all places they must never appear. Every entry keeps the ENGINE's own
   * index, so dropping some of them cannot shift what a read addresses.
   */
  const offered: SaveEntry[] = useMemo(
    () => (files
      ? indices
        .filter((index) => !files[index]!.pad)
        .map((index) => ({ index, path: files[index]!.path, size: files[index]!.size }))
      : []),
    [files, indices],
  )

  /**
   * Which of the offered files are ticked, or null for all of them.
   *
   * Null rather than a filled set, because the file list arrives from the SWARM and this state is
   * created before it: a set built at mount would be empty for good, and one rebuilt in an effect
   * would throw away a choice every time metadata re-landed. Null is also exactly what the engine's
   * plan means by an absent `wanted`, so the page and the engine say "all of them" the same way.
   */
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null)

  /** What is about to be taken: the ticked subset of the offer, still in engine indices. */
  const entries: SaveEntry[] = useMemo(
    () => (picked ? offered.filter((entry) => picked.has(entry.index)) : offered),
    [offered, picked],
  )

  const isPicked = (index: number) => !picked || picked.has(index)

  /**
   * The ticked set as one string, and then back out of it, so effects depend on WHAT is ticked.
   *
   * `entries` is rebuilt on every engine broadcast, because the snapshot it is derived from is a
   * fresh object each time, so anything keyed on the array itself re-runs once or twice a second
   * forever. That is how the thumbnail reader used to be torn down and rebuilt on every tick. This
   * changes only when the selection does.
   */
  const chosenKey = entries.map((entry) => entry.index).join(',')
  const chosenIndices = useMemo(() => (chosenKey ? chosenKey.split(',').map(Number) : []), [chosenKey])
  /* read from a click handler and from a job that outlives it, where the closure's copy is stale */
  const chosenRef = useRef<number[]>(chosenIndices)
  chosenRef.current = chosenIndices

  /**
   * Ticking is done in ENGINE file indices, never in positions in this list.
   *
   * The list is already filtered, of pads and of whatever the link left out, so a position in it
   * names a different file to the engine on every torrent that has either. That mistake exports the
   * wrong episodes under the right names, which nothing downstream can catch.
   */
  const toggle = useCallback((index: number) => {
    setPicked((was) => {
      const next = new Set(was ?? offered.map((entry) => entry.index))
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [offered])
  // back to null rather than to a filled set, so a torrent that gains a file keeps meaning "all"
  const pickAll = useCallback(() => setPicked(null), [])
  const pickNone = useCallback(() => setPicked(new Set<number>()), [])
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

  /** What is about to be taken, when that is one file: a file download rather than a zip of one. */
  const single = entries.length === 1 ? entries[0]! : null
  /**
   * What the LINK narrowed to, when that is one file.
   *
   * Separate from `single` because the two head different things. The card names the SUBJECT, which
   * is whatever the link is about and does not change as boxes are ticked; the button describes the
   * job, which does. Reading the heading off `single` renamed the whole card the moment somebody
   * ticked their way down to one episode of a pack.
   */
  const subject = offered.length === 1 ? offered[0]! : null

  const infoHash = useMemo(() => (magnet ? magnetInfoHash(magnet) ?? undefined : undefined), [magnet])

  /**
   * What the library holds for this torrent, when it holds anything, read for exactly two facts.
   *
   * `ephemeral` says whether this is the page's own cache entry or something the person put in
   * their library themselves, and it decides whether the page may write a download plan at all. A
   * plan rewrites that entry's file selection and clears its first-and-last flag, no screen in the
   * app shows either, and nothing offers a way to put them back, so narrowing somebody's own
   * torrent from an embed on a site they are only visiting would be both silent and permanent.
   *
   * `firstLast` is then carried back through unchanged, which is the rule the library's own plan
   * caller already follows: a plan message states the whole plan, so anything it omits is cleared.
   *
   * The list is broadcast to every tab whether or not anyone listens, and the subscription is
   * latched, so this is a lookup rather than a request.
   */
  const [known, setKnown] = useState<{ ephemeral: boolean, firstLast: boolean } | null>(null)
  useEffect(() => {
    if (!infoHash) return
    return client.onList((list) => {
      const found = list.find((persisted) => persisted.infoHash === infoHash)
      const next = found ? { ephemeral: found.ephemeral === true, firstLast: found.firstLast === true } : null
      // compared rather than replaced, so a list broadcast that says nothing new renders nothing new
      setKnown((was) => (
        was && next && was.ephemeral === next.ephemeral && was.firstLast === next.firstLast ? was : next
      ))
    })
  }, [client, infoHash])

  /** Files the person could pick, which is the count a full selection has to match to count as one. */
  const contentCount = files ? files.reduce((n, file) => n + (file.pad ? 0 : 1), 0) : 0

  /**
   * Tell the engine which files this page wants, so the swarm is never asked for the others.
   *
   * This is the plan the engine writes when NOBODY is claiming bytes, and that is the whole of what
   * it is for. While an export runs the claim owns the priority map and rewrites it whole on every
   * chunk, so a plan cannot narrow a running download and is not trying to: what it decides is what
   * the torrent is left wanting once the reading stops, which is the state a page-added torrent
   * spends almost all of its life in. `release` below is what brings that moment forward from "the
   * tab was closed" to "the download finished".
   *
   * Sent at the two moments the answer changes what the engine will do rather than on every tick of
   * a checkbox, because a plan is also a write to the shared library entry and, through that, an
   * upload of the library to the account.
   */
  const plan = useCallback((also: number[] = []) => {
    if (handle == null || !contentCount || !known?.ephemeral) return
    const wanted = [...new Set([...chosenRef.current, ...also])].sort((a, b) => a - b)
    // An empty plan is accepted by libtorrent and stops the torrent dead, reporting itself as
    // finished at 0 per cent rather than as anything wrong, so it is never sent.
    if (!wanted.length) return
    client.setPlan(handle, {
      // absent rather than every index, which is what says "no selection" and survives a torrent
      // gaining a file it did not have when this was decided
      wanted: wanted.length >= contentCount ? undefined : wanted,
      firstLast: known.firstLast,
    })
  }, [client, handle, contentCount, known])

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
  /*
   * Only the files this link ASKED for may supply the picture.
   *
   * `pickThumbnailSource` prefers a cover image over a video, and a cover it never fetches can never
   * be read, so without this the page reconsiders a file it is not downloading on every state tick
   * for as long as it is open. Measured: a link naming one episode still had no picture at 58 per
   * cent, waiting on an image at index 10 with no bytes at all.
   *
   * This is not enough on its own to PRODUCE a picture, and that is worth saying plainly. A video
   * source needs 512 KiB of contiguous head and a header libav can read from it, and a file whose
   * moov sits at the end has neither: Sintel fails with "Invalid data found when processing input"
   * every time. So the picture here is mostly the one already on the device, from the library or an
   * earlier visit, and a fresh embed usually keeps the glyph.
   */
  const eligible = useMemo(() => {
    const wanted = new Set(chosenIndices)
    return (index: number) => wanted.has(index)
  }, [chosenIndices])

  useThumbnailGeneration(client, infoHash, eligible)
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
  const onSaveTorrentFile = useCallback(() => {
    if (!magnet || !infoHash || savingTorrent) return
    setSavingTorrent(true)
    void saveTorrentFile({ infoHash, magnet, name: torrentName, flush: () => client.flushResume() })
      .then((result) => say(
        result === 'saved' ? 'Saved the .torrent'
          : result === 'no-metadata' ? 'The metadata has not arrived yet, so there is no .torrent to save'
            : 'The .torrent could not be built',
      ))
      .finally(() => setSavingTorrent(false))
  }, [magnet, infoHash, savingTorrent, client, torrentName, say])

  /*
   * Whether this torrent has anything to watch, asked of the files the LINK named rather than of the
   * whole torrent: a link for the subtitles of a release should not offer to play the video it did
   * not ask for.
   *
   * The LINK's set and not the ticked one, deliberately. Watching is a different action from taking
   * a copy, so a box unticked to keep a file out of an archive should not also take away the way to
   * play it, and Select none should not make this button disappear.
   *
   * `pickVideoFile` reads `name` and `size`, and an engine path is a full path, so the entries are
   * mapped rather than passed through. Its index is a position in THAT array, so it is turned back
   * into the engine's own index before it can name a file.
   */
  const watchable = useMemo(() => {
    if (!files || !offered.length) return null
    const named = offered.map((entry) => ({ name: entry.path, size: entry.size }))
    // `canOfferWatch` also answers true for an UNKNOWN list, which cannot happen here: `named` is
    // built from the offer and the guard above requires at least one
    if (!canOfferWatch(named)) return null
    const chosen = offered[pickVideoFile(named)]
    return chosen ?? null
  }, [files, offered])

  const watchHere = useMemo(() => {
    if (!magnet || !watchable) return null
    // null when the magnet cannot be encoded at all, which is the same answer as having no link
    return embedPath({ magnet, mode: 'watch', fileIndex: watchable.index })
  }, [magnet, watchable])

  // libtorrent reports a path relative to the torrent root, so a multi-file release repeats its
  // folder in front of every entry; the folder is already the heading here
  const leaf = (path: string) => path.split('/').pop() || path
  /*
   * Named only when there is a choice to have got wrong; a single file needs no restating.
   *
   * Counted over the OFFER for the same reason the link itself is: unticking every box is a
   * statement about what to download, and it used to quietly rename this button to "Watch".
   */
  const watchLabel = watchable && offered.length > 1 ? `Watch ${leaf(watchable.path)}` : 'Watch'

  const subjectName = subject ? leaf(subject.path) : torrentName
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
     *
     * The plan goes FIRST and the claim second. The claim is what moves bytes now; the plan decides
     * what the torrent is left wanting once the claiming stops, including if this page is closed
     * halfway through. So it names the ticked files AND the ones this job is about to read, which
     * are not always the same set: a row's own Download button can name a file nobody ticked.
     */
    plan(chosen.map((file) => file.index))
    claim(chosen[0]!.index)
    const controller = new AbortController()
    abortRef.current = controller
    setFailure(null)
    setFinished(null)
    setJob({ fraction: 0, label, total: chosen.reduce((n, e) => n + e.size, 0), indices: chosen.map((e) => e.index) })

    const options = { viewer, signal: controller.signal }
    const onProgress = (fraction: number) => setJob((j) => (j ? { ...j, fraction } : j))
    const only = chosen.length === 1 ? chosen[0]! : null

    const run = only
      ? saveTorrentFileToDisk(client, handle, only.index, only.path, only.size, onProgress, options)
      : saveTorrentEntriesAsZipToDisk(client, handle, torrentName, chosen, onProgress, options)

    run
      .then(() => {
        setFinished(only ? leaf(only.path) : `${chosen.length} files`)
        // so the list can say which files are already on the device, which is the whole of what
        // somebody coming back for the rest of a pack needs to know
        setSaved((was) => new Set([...was, ...chosen.map((file) => file.index)]))
      })
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
        if (!mounted.current) return
        /*
         * Hand the claim back, which is the step that used to be missing.
         *
         * A claim asks the swarm for one file and skips every other, and it outlives the export that
         * made it, so a CANCELLED download carried on into browser storage until the tab was closed:
         * the button said stopped and the engine kept going. Holding instead is also the only state
         * in which the engine writes the plan above, so this is where "only the ticked files" stops
         * being about this download and starts being true of the torrent.
         *
         * The plan is re-sent first because the ticks may have moved while this was running.
         */
        plan()
        release()
      })
  }, [client, handle, viewer, claim, release, plan, torrentName])

  const cancel = () => abortRef.current?.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

  /**
   * A page that goes away takes its download with it.
   *
   * The engine claim is released on unmount, and an ephemeral torrent with no viewers is paused, so
   * an export left running past this point would block on reads that can no longer be served and
   * spend four 120s timeouts finding that out, writing into a sink whose frame is already gone.
   */
  useEffect(() => () => { mounted.current = false; cancel() }, [])

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
  /** Enough to run the button at the top, which acts on the ticked set and needs one. */
  const ready = Boolean(files) && entries.length > 0 && handle != null
  /**
   * Enough to run a ROW's button, which needs no ticks at all.
   *
   * Deliberately not `ready`: a row is its own action, so pressing Download beside a file has to
   * work with every box unticked, and gating the rows on the main button's precondition would have
   * turned Select none into a page with nothing on it that does anything.
   */
  const listReady = Boolean(files) && handle != null
  const label = !magnet
    ? 'Nothing to download'
    : !files
      ? 'Loading torrent…'
      : busy
        ? job.label
        : offered.length === 0
          ? 'No matching files'
          : entries.length === 0
            ? 'Select at least one file'
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
                : subject ? <FileIcon /> : <Folder />}
            </div>
            <div className="about">
              <div className="name">{subjectName}</div>
              {/* The SELECTION's size, which is what the button is about to take, and which moves
                  as boxes are ticked. The two empty cases are different facts and read as different
                  sentences: a link naming files this torrent does not have is the sender's mistake,
                  where an empty selection is a choice made on this screen a moment ago. */}
              <div className="meta">
                {offered.length === 0
                  ? files
                    ? 'None of the requested files are in this torrent'
                    : 'Reading the torrent from the network'
                  : entries.length === 0
                    ? 'Nothing selected'
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
              <button type="button" onClick={onSaveTorrentFile} disabled={savingTorrent || !infoHash} {...hint('Save the .torrent file for this torrent')}>
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

          {/**
            * The choice, and the reason this section is open rather than folded away.
            *
            * It used to be a disclosure over a list somebody could read, so leaving it shut cost
            * them nothing. It now holds the decision the page is asking them to make, and a
            * decision behind a summary is one most people never find. It still folds, because a
            * pack of forty is a lot of card, and it is only here at all when there is a choice: one
            * file is not a selection.
            */}
          {offered.length > 1 && (
            <details className="files" open>
              <summary>
                {entries.length === offered.length
                  ? `${offered.length} files`
                  : `${entries.length} of ${offered.length} files`}
              </summary>
              <div className="bulk">
                <button type="button" onClick={pickAll} disabled={entries.length === offered.length}>
                  Select all
                </button>
                <button type="button" onClick={pickNone} disabled={entries.length === 0}>
                  Select none
                </button>
              </div>
              <div className="list">
                {offered.map((file) => {
                  const on = isPicked(file.index)
                  const running = job?.indices.includes(file.index) === true
                  return (
                    <div className={on ? 'file' : 'file off'} key={file.index}>
                      {/* The tick is named by the file, through the label wrapping both, so a
                          screen reader reads "E01.mkv, checkbox" rather than twenty-four boxes
                          with nothing to tell them apart. */}
                      <label className="pick">
                        <input type="checkbox" checked={on} onChange={() => toggle(file.index)}/>
                        <span className="name">{leaf(file.path)}</span>
                      </label>
                      <span className="size">{getHumanReadableByteString(file.size)}</span>
                      {running
                        ? <span className="mark">Downloading</span>
                        : saved.has(file.index) && <span className="mark saved"><Check/>Saved</span>}
                      {/**
                        * Shows "Download" and ANNOUNCES the file, because the visible label is only
                        * unambiguous next to the name in the same row. Read on its own, as a screen
                        * reader's element list does, a season pack is otherwise 24 buttons that all say
                        * the same word. The visible text stays a prefix of the accessible name, so
                        * "click Download" still addresses this button by voice.
                        *
                        * Disabled only while a download is RUNNING, and enabled again the moment it
                        * ends, which is the whole of "take one file now and come back for the rest".
                        * One at a time because two exports share this page's single claim on the
                        * torrent and would re-anchor it away from each other on every chunk.
                        */}
                      <button
                        aria-label={`Download ${leaf(file.path)}`}
                        onClick={() => start([file], `Downloading ${leaf(file.path)}`)}
                        disabled={!listReady || busy}
                      >
                        Download
                      </button>
                    </div>
                  )
                })}
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
