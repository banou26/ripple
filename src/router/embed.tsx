import type { MediaPlayerSource } from '@banou/media-player'

import { useEffect, useMemo } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'
import { MediaPlayer } from '@banou/media-player'

import { getHumanReadableByteString } from '../utils/bytes'
import { downloadedByteRanges } from '../torrent/downloaded-ranges'
import { usePlayerTorrent } from '../torrent/use-player-torrent'
import { TooltipDisplay } from '../components/tooltip-display'

const playerStyle = css`
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: #000;

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
    padding-bottom: calc(1.2 * var(--mp-unit));
    padding-left: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-left, 0px));
    padding-right: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-right, 0px));
    @media (min-width: 768px) {
      padding-top: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(2.4 * var(--mp-unit));
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
    text-shadow: 0 0 4px rgba(0, 0, 0, 1);
    color: #fff;
    white-space: nowrap;

    /* the same wash the player puts behind its own title, so light footage cannot swallow either end */
    background: linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.3) 30%, rgba(0,0,0,0.2) 60%, rgba(0,0,0,0.1) 80%, transparent 100%);
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

  /* the slot itself takes no pointer events, so the tooltip anchors ask for them back */
  .media-information {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: calc(1.2 * var(--mp-unit));

    .item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
  }
`

const Player = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, fileIndex: _fileIndex } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => (_magnet ? atob(_magnet) : undefined), [_magnet])
  const fileIndex = useMemo(() => Number(_fileIndex || 0), [_fileIndex])
  const { snapshot, engineError, read, readQuiet, prioritizeFrom } = usePlayerTorrent(magnet, fileIndex)

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

  // jassub's prebuilt worker is a classic script, so wrap it via importScripts; a memo, not an effect, because a changing URL identity tears the pipeline down
  const jassubWorkerUrl = useMemo(() => {
    const url = new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker.js`, origin).toString()
    return URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(url)})`], { type: 'application/javascript' }))
  }, [origin])

  useEffect(() => () => URL.revokeObjectURL(jassubWorkerUrl), [jassubWorkerUrl])

  const jassubWasmUrl = useMemo(
    () => new URL(`${import.meta.env.DEV ? '/build' : ''}/jassub-worker-modern.wasm`, origin).toString(),
    [origin]
  )

  const defaultFontUrl = useMemo(() => new URL(`${publicPath}default.woff2`).toString(), [publicPath])

  const st = snapshot?.status
  const info = {
    peers: st?.numPeers ?? 0,
    downloadSpeed: snapshot?.displayDownloadRate ?? 0,
    uploadSpeed: st?.uploadRate ?? 0,
  }

  const hasMetadata = Boolean(snapshot?.files)
  const downloaded = snapshot?.status?.totalDone ?? 0
  // Why there is nothing to watch yet, or null once there is. Kept apart from the byte counter
  // because only the counter is dropped when the row runs out of room.
  const status = engineError ?? (hasMetadata ? null : 'Loading metadata…')
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

  const overlay = (
    <div className="ripple-overlay-content">
      {/* always rendered, empty or not: it is what takes the width the rest of the row leaves */}
      <div className="file-name">{fileName}</div>
      {/* once the engine errors nothing will ever arrive, so say that instead of spinning forever */}
      {status
        ? <div className="loading-information">{status}</div>
        : <div className="downloaded">Downloaded {getHumanReadableByteString(downloaded)}</div>}
      <div className="media-information" data-testid="media-information">
        <TooltipDisplay
          id="peers"
          text={<div className="item"><User /><span>{info.peers}</span></div>}
          toolTipText={<span>Peers: {info.peers}<br />Computers connected to you</span>}
        />
        <TooltipDisplay
          id="download-speed"
          text={<div className="item"><ArrowDown /><span>{getHumanReadableByteString(info.downloadSpeed, true)}/s</span></div>}
          toolTipText={<span>Download speed: {getHumanReadableByteString(info.downloadSpeed)}/s</span>}
        />
        <TooltipDisplay
          id="upload-speed"
          text={<div className="item"><ArrowUp /><span>{getHumanReadableByteString(info.uploadSpeed, true)}/s</span></div>}
          toolTipText={<span>Upload speed: {getHumanReadableByteString(info.uploadSpeed)}/s</span>}
        />
        {/* audio and subtitle pickers live in the player's own settings menu now */}
      </div>
    </div>
  )

  return (
    <div css={playerStyle}>
      <MediaPlayer
        {...source}
        // No `title`: the player would draw it full width in a layer of its own, where it cannot see
        // the readout above it and runs underneath it on a narrow screen. The overlay row below
        // carries the filename instead, in the same flex line as the numbers it has to give way to.
        publicPath={publicPath}
        libavWorkerUrl={libavWorkerUrl}
        jassubWorkerUrl={jassubWorkerUrl}
        jassubWasmUrl={jassubWasmUrl}
        defaultFontUrl={defaultFontUrl}
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

export default Player
