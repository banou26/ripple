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
   * One right-aligned group, because the player's top bar gives it the right-hand end of the row and
   * keeps the left for the filename. It supplies the padding and the fade too, so this sizes itself
   * against the player's own unit rather than against \`rem\`, and adds no padding of its own.
   */
  .ripple-overlay-content {
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
      {/* once the engine errors nothing will ever arrive, so say that instead of spinning forever */}
      <div className="loading-information">
        {engineError
          ?? (!hasMetadata
            ? 'Loading metadata…'
            : `Downloaded ${getHumanReadableByteString(downloaded)}`)}
      </div>
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
        title={fileName}
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
