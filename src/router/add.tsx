import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { getTorrentClient } from '../torrent/client'
import { useTorrents } from '../torrent/use-torrents'
import { getHumanReadableByteString } from '../utils/bytes'
import { describeAddRequest, type AddRequest } from './add-request'
import { getRoutePath, Route } from './path'

/**
 * The page another site sends someone to in order to put a torrent in their library.
 *
 * `/embed` plays a torrent and deliberately leaves no trace: what it adds is marked `ephemeral`, so
 * the engine may reclaim its bytes and it never appears as something the person chose to keep. This
 * is the opposite, and the difference is the whole reason it is a separate route.
 *
 * IT NEVER ADDS ON ARRIVAL, and that is not a detail to optimise away later. Anything on the web can
 * navigate a browser here, so an `/add` that acted on load would let any page put torrents in
 * someone's library and start them downloading, with one link and no gesture. So this renders what
 * would be added, says who asked, and waits. The add happens on a click or it does not happen.
 *
 * The FILE LIST is why the page reads metadata on arrival, and that is worth being clear about since
 * it is a side effect of following a link. It adds the torrent marked `ephemeral`, exactly as
 * `/embed` does: the engine treats those bytes as a cache it may reclaim at any time, and the row
 * never appears in the library. So visiting costs a metadata fetch from the swarm and nothing else,
 * and the actual add is still a click away. Cancelling drops it again, unless it was already in the
 * library when the page opened, in which case it was never ours to remove.
 *
 * For the same reason it refuses to do anything inside a frame. A page that can size and position an
 * invisible iframe can put this button under the visitor's cursor while they think they are clicking
 * something else, and no amount of wording inside the frame fixes that, because the attacker chooses
 * what is visible. Framed, it offers a link out instead, which cannot be borrowed the same way.
 */

const style = css`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  color: #f4f2f8;
  background: #0f0d14;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  .card {
    width: 100%;
    max-width: 560px;
    background: #17141d;
    border: 1px solid #2c2737;
    border-radius: 16px;
    padding: 28px;
  }

  h1 {
    margin: 0 0 4px;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .from {
    margin: 0 0 22px;
    font-size: 0.85rem;
    color: #8b8499;

    b {
      color: #c9c4d4;
      font-weight: 600;
    }
  }

  .name {
    font-size: 1.05rem;
    line-height: 1.45;
    word-break: break-word;
    margin-bottom: 14px;
  }

  dl {
    margin: 0 0 24px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 7px 16px;
    font-size: 0.85rem;

    dt { color: #8b8499; }

    dd {
      margin: 0;
      color: #c9c4d4;
      word-break: break-all;
      font-variant-numeric: tabular-nums;
    }
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  button, .button {
    font: inherit;
    font-size: 0.9rem;
    padding: 9px 20px;
    border-radius: 999px;
    border: 1px solid #2c2737;
    background: none;
    color: #c9c4d4;
    cursor: pointer;
    text-decoration: none;

    &:hover { border-color: #3a3447; color: #f4f2f8; }

    &.primary {
      background: #f97316;
      border-color: #f97316;
      color: #1a1020;
      font-weight: 600;

      &:hover { background: #fb8a3c; }
    }
  }

  .files {
    margin: 0 0 22px;
    border: 1px solid #2c2737;
    border-radius: 10px;
    max-height: 240px;
    overflow-y: auto;

    .file {
      display: flex;
      align-items: baseline;
      gap: 14px;
      padding: 8px 14px;
      font-size: 0.85rem;
      border-bottom: 1px solid #221e2b;

      &:last-child { border-bottom: none; }

      .path {
        flex: 1;
        min-width: 0;
        color: #c9c4d4;
        word-break: break-word;

        .dir { color: #8b8499; }
      }

      .size {
        flex-shrink: 0;
        color: #8b8499;
        font-variant-numeric: tabular-nums;
      }
    }
  }

  .reading {
    margin: 0 0 22px;
    font-size: 0.85rem;
    color: #8b8499;
  }

  .problem {
    color: #f8a5a5;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .note {
    margin-top: 20px;
    font-size: 0.8rem;
    line-height: 1.55;
    color: #8b8499;
  }
`

/** Who sent them here, as an origin and never as a whole URL, which can carry anything. */
const referrerOrigin = (): string | null => {
  try {
    if (!document.referrer) return null
    const origin = new URL(document.referrer).origin
    return origin === window.location.origin ? null : origin
  } catch { return null }
}

/** `a/b/c.mkv` shown as a dimmed `a/b/` and a bright `c.mkv`, so a pack scans by filename */
const FilePath = ({ path }: { path: string }) => {
  const cut = path.lastIndexOf('/')
  return cut < 0
    ? <>{path}</>
    : <><span className="dir">{path.slice(0, cut + 1)}</span>{path.slice(cut + 1)}</>
}

const Add = () => {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const client = getTorrentClient()
  const { torrents, addMagnet } = useTorrents()
  const [added, setAdded] = useState(false)

  const request: AddRequest = useMemo(
    () => describeAddRequest({ magnet: params.get('magnet'), name: params.get('name') }),
    [params],
  )

  const [from] = useState(referrerOrigin)
  // `window.top !== window` throws on nothing: the comparison is allowed cross-origin, unlike
  // reading anything off the other window
  const [framed] = useState(() => { try { return window.top !== window.self } catch { return true } })

  const preview = request.ok
    ? torrents.find((t) => t.infoHash && t.infoHash === request.infoHash)
    : undefined
  const files = preview?.files ?? []
  const totalBytes = files.reduce((n, f) => n + f.size, 0)

  /**
   * Is this already theirs, or only the cache entry this page made to read the file list?
   *
   * The engine's own `ephemeral` flag answers it exactly. Watching the list cannot: the preview add
   * puts a row there too, so "it is in the list" is true either way within a moment of arriving, and
   * a latch racing that would sometimes offer to remove something the person already had.
   */
  const inLibrary = !!preview && preview.state !== 'missing' && !preview.ephemeral

  // Read the file list, without keeping anything. `ephemeral` is what makes this a cache entry the
  // engine may reclaim rather than something the person chose to keep, and it is also why a magnet
  // that is ALREADY in the library is not demoted by it: the worker treats an ephemeral add of a
  // known torrent as a touch, and `mergeEntry` ANDs the flag, so a library row stays a library row.
  useEffect(() => {
    if (!request.ok || framed) return
    client.addMagnet(request.magnet, { ephemeral: true })
  }, [client, request, framed])

  useEffect(() => {
    if (!added) return
    const timer = setTimeout(() => navigate(getRoutePath(Route.HOME)), 900)
    return () => clearTimeout(timer)
  }, [added, navigate])

  const onAdd = () => {
    if (!request.ok) return
    // the same magnet without `ephemeral`, which is the gesture that promotes it out of the cache
    addMagnet(request.magnet)
    setAdded(true)
  }

  const onCancel = () => {
    // only what this page created: anything that was already theirs is left exactly as it was
    if (preview && preview.ephemeral && preview.state !== 'missing') {
      client.remove(Number(preview.id), true)
    }
    navigate(getRoutePath(Route.HOME))
  }

  return (
    <div css={style}>
      <div className="card">
        {!request.ok
          ? (
            <>
              <h1>Nothing to add</h1>
              <p className="problem">{request.problem}</p>
              <div className="actions">
                <Link className="button" to={getRoutePath(Route.HOME)}>Open Ripple</Link>
              </div>
            </>
          )
          : (
            <>
              <h1>Add torrent</h1>
              <p className="from">
                {from ? <>Sent here by <b>{from}</b>.</> : <>Opened directly.</>}
                {' '}Nothing is added until you say so.
              </p>

              <div className="name">{request.name}</div>

              {files.length > 0
                ? (
                  <div className="files">
                    {files.map((file) => (
                      <div className="file" key={file.name}>
                        <span className="path"><FilePath path={file.name}/></span>
                        <span className="size">{getHumanReadableByteString(file.size, true)}</span>
                      </div>
                    ))}
                  </div>
                )
                : <p className="reading">Reading the file list from the swarm...</p>}

              <dl>
                {(totalBytes > 0 || request.sizeBytes !== undefined) && (
                  <>
                    <dt>Size</dt>
                    <dd>
                      {getHumanReadableByteString(totalBytes || request.sizeBytes!, true)}
                      {files.length > 1 && ` in ${files.length} files`}
                    </dd>
                  </>
                )}
                <dt>Info hash</dt>
                <dd>{request.infoHash}</dd>
                <dt>Trackers</dt>
                <dd>{request.trackers === 0 ? 'None, it will rely on the DHT and peer exchange' : request.trackers}</dd>
              </dl>

              {added
                ? <p>Added. Taking you to your library.</p>
                : inLibrary
                  ? (
                    <>
                      <p>This one is already in your library.</p>
                      <div className="actions">
                        <Link className="button primary" to={getRoutePath(Route.HOME)}>Open your library</Link>
                      </div>
                    </>
                  )
                  : framed
                    ? (
                      <>
                        <p className="problem">
                          This page is inside a frame on another site, so Ripple will not add anything from
                          here. The site around it decides what you can see, which is not a position to be
                          agreeing to something from.
                        </p>
                        <div className="actions">
                          <a
                            className="button primary"
                            href={window.location.href}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            Open this in a new tab
                          </a>
                        </div>
                      </>
                    )
                    : (
                      <div className="actions">
                        <button className="primary" onClick={onAdd}>Add torrent</button>
                        <button onClick={onCancel}>Cancel</button>
                      </div>
                    )}

              <p className="note">
                Ripple downloads into your browser's own storage, and shares what it has with other
                peers while it does. You can change where the files end up, and remove it again, from
                your library.
              </p>
            </>
          )}
      </div>
    </div>
  )
}

export default Add
