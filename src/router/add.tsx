import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { useTorrents } from '../torrent/use-torrents'
import { magnetInfoHash, magnetParam } from '../torrent/magnet'
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

const Add = () => {
  const [params] = useSearchParams()
  const navigate = useNavigate()
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

  const already = request.ok
    ? torrents.find((t) => t.infoHash && t.infoHash === request.infoHash)
    : undefined

  useEffect(() => {
    if (!added) return
    const timer = setTimeout(() => navigate(getRoutePath(Route.HOME)), 900)
    return () => clearTimeout(timer)
  }, [added, navigate])

  const onAdd = () => {
    if (!request.ok) return
    addMagnet(request.magnet)
    setAdded(true)
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
              <h1>Add this torrent to Ripple?</h1>
              <p className="from">
                {from ? <>Sent here by <b>{from}</b>.</> : <>Opened directly.</>}
                {' '}Nothing is added until you say so.
              </p>

              <div className="name">{request.name}</div>

              <dl>
                {request.sizeBytes !== undefined && (
                  <>
                    <dt>Size</dt>
                    <dd>{getHumanReadableByteString(request.sizeBytes, true)}</dd>
                  </>
                )}
                <dt>Info hash</dt>
                <dd>{request.infoHash}</dd>
                <dt>Trackers</dt>
                <dd>{request.trackers === 0 ? 'None, it will rely on the DHT and peer exchange' : request.trackers}</dd>
              </dl>

              {added
                ? <p>Added. Taking you to your library.</p>
                : already
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
                        <button className="primary" onClick={onAdd}>Add to Ripple</button>
                        <Link className="button" to={getRoutePath(Route.HOME)}>Cancel</Link>
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
