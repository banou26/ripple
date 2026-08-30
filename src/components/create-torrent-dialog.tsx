import { css } from '@emotion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CreateOptions } from '../torrent/create-source'
import type { UseCreateTorrent } from '../torrent/use-create-torrent'

import {
  BORDER,
  BORDER_INTERACTIVE,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  EMPHASIS,
  EMPHASIS_HOVER,
  FOCUS_RING,
  SUNKEN_BG,
  SURFACE_BG,
  TEXT,
  TEXT_FAINT,
  TEXT_MUTED,
  TEXT_ON_LIGHT,
  WARN,
} from '../theme'
import { DEFAULT_TRACKERS } from '../torrent/create-source'
import { getHumanReadableByteString } from '../utils/bytes'
import { hashEta } from '../torrent/hash-pieces'
import { Modal } from './modal'

/**
 * Make a torrent out of something on this device.
 *
 * Four states on one surface, in the order they happen: pick, review, work, share. A wizard was the
 * obvious alternative and is wrong here, because the interesting moment is the review: the numbers
 * that decide whether somebody wants to go on (how many files, how big, what it will announce to)
 * all belong on screen at once, next to the button that starts it.
 *
 * The sentence about what publishing means is not a warning banner and is not dismissible. It is one
 * line of ordinary copy under the button, because that is where somebody reads it, and because a
 * torrent is a thing whose whole purpose is to be downloadable by whoever has the link. Saying so
 * once, plainly, is the honest amount.
 */

const style = css`
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
  width: min(52rem, 92vw);
  color: ${TEXT};

  h2 { margin: 0; font-size: 1.6rem; font-weight: 600; }
  p { margin: 0; color: ${TEXT_MUTED}; line-height: 1.5; }
  .faint { color: ${TEXT_FAINT}; font-size: 1.2rem; }

  .picks { display: flex; gap: 0.8rem; flex-wrap: wrap; }

  button {
    font: inherit;
    color: ${TEXT};
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER};
    border-radius: 0.6rem;
    padding: 0.7rem 1.1rem;
    cursor: pointer;
    &:hover { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_INTERACTIVE}; }
    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 2px; }
    &:disabled { opacity: 0.35; cursor: default; }
  }
  button.go {
    background: ${EMPHASIS};
    color: ${TEXT_ON_LIGHT};
    border-color: transparent;
    font-weight: 600;
    &:hover:not(:disabled) { background: ${EMPHASIS_HOVER}; }
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.8rem;
    background: ${SUNKEN_BG};
    border: 1px solid ${BORDER};
    border-radius: 0.6rem;
    padding: 1rem;
  }
  .fact { display: flex; flex-direction: column; gap: 0.2rem; }
  .fact .label { color: ${TEXT_FAINT}; font-size: 1.1rem; }
  .fact .value { font-variant-numeric: tabular-nums; }

  label.field { display: flex; flex-direction: column; gap: 0.4rem; }
  label.field > span { color: ${TEXT_FAINT}; font-size: 1.2rem; }
  input[type=text], textarea {
    font: inherit;
    color: ${TEXT};
    background: ${SURFACE_BG};
    border: 1px solid ${BORDER};
    border-radius: 0.5rem;
    padding: 0.6rem 0.8rem;
    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }
  }
  textarea { resize: vertical; min-height: 5.4rem; font-size: 1.2rem; }

  label.check { display: flex; gap: 0.6rem; align-items: baseline; cursor: pointer; }

  .bar {
    height: 0.6rem;
    background: ${SUNKEN_BG};
    border-radius: 0.3rem;
    overflow: hidden;
    > div { height: 100%; background: ${EMPHASIS}; transition: width 0.2s linear; }
  }

  .warn { color: ${WARN}; }
  .row { display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .skipped { max-height: 8rem; overflow-y: auto; font-size: 1.2rem; color: ${TEXT_FAINT}; }
  code { font-size: 1.2rem; word-break: break-all; }
`

type Props = {
  create: UseCreateTorrent
  onClose: () => void
  /** Hands the finished torrent to whatever already knows how to offer a link for one. */
  onShare: (magnet: string) => void
  onToast: (message: string) => void
}

export const CreateTorrentDialog = ({ create, onClose, onShare, onToast }: Props) => {
  const { state, suggestedName } = create
  const [name, setName] = useState('')
  const [trackerText, setTrackerText] = useState(DEFAULT_TRACKERS.join('\n'))
  const [isPrivate, setPrivate] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const first = useRef<HTMLButtonElement>(null)

  // the pick decides the default name, and only the pick: a later edit is the person's
  useEffect(() => { setName(suggestedName) }, [suggestedName])
  useEffect(() => { if (state.stage === 'hashing' && !startedAt) setStartedAt(Date.now()) }, [state.stage, startedAt])

  const options: CreateOptions = useMemo(() => ({
    name,
    trackers: trackerText.split('\n'),
    private: isPrivate,
  }), [name, trackerText, isPrivate])

  const working = state.stage === 'reading' || state.stage === 'hashing' || state.stage === 'checking' || state.stage === 'adding'
  const eta = state.progress && startedAt ? hashEta(state.progress, Date.now() - startedAt) : undefined
  const done = state.progress ? state.progress.hashedBytes / Math.max(1, state.progress.totalBytes) : 0

  return (
    <Modal labelledBy="create-torrent-title" onClose={working ? create.cancel : onClose} initialFocus={first}>
      <div css={style}>
        <h2 id="create-torrent-title">Create a torrent</h2>

        {state.stage === 'idle' && (
          <>
            <p>
              Pick a file or a folder on this device. Ripple reads it where it is, builds the torrent,
              and shares it from there. Nothing is copied and nothing is moved.
            </p>
            <div className="picks">
              <button ref={first} type="button" onClick={() => void create.pickFolder()}>Choose a folder</button>
              <button type="button" onClick={() => void create.pickFile()}>Choose a file</button>
            </div>
          </>
        )}

        {state.stage === 'reading' && (
          <>
            <p>Reading the folder{state.filesFound ? `, ${state.filesFound} files so far` : ''}…</p>
            <button type="button" onClick={create.cancel}>Cancel</button>
          </>
        )}

        {(state.stage === 'ready' || state.stage === 'error') && state.plan && (
          <>
            <div className="facts">
              <div className="fact">
                <span className="label">Files</span>
                <span className="value">{state.plan.files.length}</span>
              </div>
              <div className="fact">
                <span className="label">Total size</span>
                <span className="value">{getHumanReadableByteString(state.plan.totalBytes)}</span>
              </div>
              <div className="fact">
                <span className="label">Pieces</span>
                <span className="value">
                  {state.plan.pieceCount} × {getHumanReadableByteString(state.plan.pieceLength)}
                </span>
              </div>
            </div>

            {state.truncated && (
              <p className="warn">
                That folder holds more files than Ripple will put in one torrent. Pick a smaller
                folder, or nothing here will describe all of it.
              </p>
            )}
            {state.skipped.length > 0 && (
              <details>
                <summary className="faint">{state.skipped.length} left out</summary>
                <div className="skipped">{state.skipped.map((path) => <div key={path}>{path}</div>)}</div>
              </details>
            )}

            <label className="field">
              <span>Name</span>
              <input type="text" value={name} onChange={(event) => setName(event.target.value)}/>
            </label>

            <label className="field">
              <span>Trackers, one per line. Leave it empty to rely on the DHT alone.</span>
              <textarea value={trackerText} onChange={(event) => setTrackerText(event.target.value)}/>
            </label>

            <label className="check">
              <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)}/>
              <span>
                Private
                <span className="faint"> · keeps it to the trackers above, with no DHT and no peer exchange</span>
              </span>
            </label>

            {state.error && <p className="warn">{state.error}</p>}

            <div className="row">
              <button ref={first} className="go" type="button" onClick={() => void create.publish(options)}>
                Create and start sharing
              </button>
              <button type="button" onClick={create.reset}>Pick something else</button>
            </div>
            <p className="faint">
              Sharing means anyone with the link can download these files while this tab is open. The
              files stay where they are and Ripple never writes to them.
            </p>
          </>
        )}

        {(state.stage === 'hashing' || state.stage === 'checking') && (
          <>
            <p>
              {state.stage === 'checking'
                ? 'Checking the files did not change while that ran…'
                : 'Reading and hashing the files…'}
            </p>
            <div className="bar"><div style={{ width: `${Math.round(done * 100)}%` }}/></div>
            <p className="faint">
              {state.progress
                ? `${getHumanReadableByteString(state.progress.hashedBytes)} of ${getHumanReadableByteString(state.progress.totalBytes)}`
                  + (eta === undefined ? '' : ` · about ${eta}s left`)
                  + ` · ${state.progress.path}`
                : 'starting…'}
            </p>
            <button type="button" onClick={create.cancel}>Cancel</button>
          </>
        )}

        {state.stage === 'adding' && <p>Handing it to the engine…</p>}

        {state.stage === 'done' && state.built && (
          <>
            <p>
              <strong>{state.built.plan.name}</strong> is being shared from where it sits on this
              device.
            </p>
            <p className="faint">Info hash <code>{state.built.infoHash}</code></p>
            <div className="row">
              <button
                ref={first}
                className="go"
                type="button"
                onClick={() => { onShare(state.built!.magnet); onClose() }}
              >
                Get a share link
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(state.built!.magnet)
                    .then(() => onToast('Magnet link copied'))
                    .catch(() => onToast('Could not copy the link'))
                }}
              >
                Copy magnet
              </button>
              <button type="button" onClick={create.reset}>Create another</button>
              <span className="grow"/>
              <button type="button" onClick={onClose}>Done</button>
            </div>
            <p className="faint">
              It keeps sharing while Ripple is open. After a reload the browser asks for access to
              those files again before it can carry on.
            </p>
          </>
        )}

        {state.stage === 'error' && !state.plan && (
          <>
            <p className="warn">{state.error}</p>
            <button ref={first} type="button" onClick={create.reset}>Try again</button>
          </>
        )}
      </div>
    </Modal>
  )
}
