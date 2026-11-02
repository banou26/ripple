import { css } from '@emotion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useIntl, type IntlShape } from 'react-intl'

import type { CreateOptions } from '../torrent/create-source'
import type { UseCreateTorrent } from '../torrent/use-create-torrent'

import {
  BORDER,
  BORDER_INTERACTIVE,
  BORDER_STRONG,
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
import { wordsOf } from '../i18n'
import { DEFAULT_TRACKERS } from '../torrent/create-source'
import type { TorrentFormat } from '../torrent/make-torrent'

import { MAX_PIECE_LENGTH, MIN_PIECE_LENGTH, contentFiles, dropsFolderName } from '../torrent/make-torrent'
import { getHumanReadableByteString } from '../utils/bytes'
import { writeDuration } from '../torrent/uptime'
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

/*
 * The same card shell as torrent-options-dialog and add-torrent-dialog: a bordered surface inside
 * Ripple's Modal, with its own header and footer and only the middle scrolling.
 *
 * Worth stating why the border rather than a shadow. Neither card carries a drop shadow, so the
 * border is the ONLY thing separating the surface from the scrim; without it this read as content
 * floating on a dark backdrop rather than as a dialog, which is exactly how it was reported.
 */
const style = css`
  color: ${TEXT};
  width: 100%;
  max-width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);

  .card {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 64px);
    border-radius: 8px;
    border: 1px solid ${BORDER_STRONG};
    background: ${SURFACE_BG};
  }

  header {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid ${BORDER};

    h2 {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 1.05rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 18px 16px;
  }

  footer {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 18px;
    border-top: 1px solid ${BORDER};
  }

  p { margin: 0; color: ${TEXT_MUTED}; line-height: 1.5; font-size: 0.85rem; }
  .faint { color: ${TEXT_FAINT}; font-size: 0.8rem; }

  .picks { display: flex; gap: 8px; flex-wrap: wrap; }

  button {
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
    color: ${TEXT};
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER};
    border-radius: 6px;
    padding: 6px 18px;
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
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 10px;
    background: ${SUNKEN_BG};
    border: 1px solid ${BORDER};
    border-radius: 6px;
    padding: 12px;
  }
  .fact { display: flex; flex-direction: column; gap: 2px; }
  .fact .label {
    color: ${TEXT_MUTED};
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .fact .value { font-variant-numeric: tabular-nums; font-size: 0.95rem; }

  label.field { display: flex; flex-direction: column; gap: 4px; }
  label.field > span {
    color: ${TEXT_MUTED};
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  input[type=text], textarea {
    font: inherit;
    font-size: 0.85rem;
    color: ${TEXT};
    background: ${SUNKEN_BG};
    border: 1px solid ${BORDER};
    border-radius: 6px;
    padding: 8px 10px;
    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }
  }
  textarea { resize: vertical; min-height: 4.6rem; font-size: 0.8rem; }

  label.check { display: flex; gap: 8px; align-items: baseline; cursor: pointer; font-size: 0.85rem; }

  select {
    font: inherit;
    font-size: 0.85rem;
    color: ${TEXT};
    background: ${SUNKEN_BG};
    border: 1px solid ${BORDER};
    border-radius: 6px;
    padding: 8px 10px;
    &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }
  }

  details > summary { cursor: pointer; }
  .more { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; }

  .bar {
    height: 6px;
    background: ${SUNKEN_BG};
    border-radius: 3px;
    overflow: hidden;
    > div { height: 100%; background: ${EMPHASIS}; transition: width 0.2s linear; }
  }

  .warn { color: ${WARN}; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .skipped { max-height: 8rem; overflow-y: auto; font-size: 0.8rem; color: ${TEXT_FAINT}; }
  code { font-size: 0.8rem; word-break: break-all; }
`

/**
 * Every power of two the encoder accepts, so the list cannot drift from `isValidPieceLength`.
 *
 * BINARY units on purpose. `getHumanReadableByteString` is SI, where k is 1000, so it renders 16384
 * as `16.4 kB`: correct, and absurd beside a control whose whole vocabulary is powers of two.
 */
const PIECE_CHOICES = (() => {
  const out: number[] = []
  for (let size = MIN_PIECE_LENGTH; size <= MAX_PIECE_LENGTH; size *= 2) out.push(size)
  return out
})()

const binaryBytes = (bytes: number, intl: IntlShape): string =>
  bytes >= 1024 * 1024
    ? intl.formatMessage({ id: '{size} MiB', defaultMessage: '{size} MiB' }, { size: bytes / (1024 * 1024) })
    : intl.formatMessage({ id: '{size} KiB', defaultMessage: '{size} KiB' }, { size: bytes / 1024 })

type Props = {
  create: UseCreateTorrent
  onClose: () => void
  /** Hands the finished torrent to whatever already knows how to offer a link for one. */
  onShare: (magnet: string) => void
  onToast: (message: string) => void
}

export const CreateTorrentDialog = ({ create, onClose, onShare, onToast }: Props) => {
  const intl = useIntl()
  const { state, suggestedName } = create
  const [name, setName] = useState('')
  const [trackerText, setTrackerText] = useState(DEFAULT_TRACKERS.join('\n'))
  const [isPrivate, setPrivate] = useState(false)
  const [webSeedText, setWebSeedText] = useState('')
  const [comment, setComment] = useState('')
  const [sourceTag, setSourceTag] = useState('')
  /** Empty string is Auto, which means `plan()` picks from the total size. */
  const [pieceChoice, setPieceChoice] = useState('')
  /**
   * v1 by default, because it is the only format every client understands.
   *
   * Hybrid is the better torrent and is not the safe default: it costs one piece of padding per file
   * and a client that has not implemented BEP 52 still reads the v1 half, so nobody is shut out, but
   * the padding is real and somebody sharing a thousand small files should choose it knowingly.
   */
  const [format, setFormat] = useState<TorrentFormat>('v1')
  const [startedAt, setStartedAt] = useState(0)
  const first = useRef<HTMLButtonElement>(null)

  /*
   * A NEW PICK resets the controls, and it has to reset ALL of them.
   *
   * `take()` re-plans from the pick alone, so the plan that lands is v1 at the automatic piece
   * length. Leaving the selects showing a previous choice made the review facts describe a torrent
   * that would not be created: the grid read 19 pieces and no padding while the button was about to
   * build a hybrid with 300 pieces and four megabytes of pad files, because `options` still carried
   * the old format. What is on screen and what the button makes now come from the same pick.
   *
   * `startedAt` goes with them. It is the clock the hashing estimate divides by, and it was only
   * ever assigned while still zero, so a second torrent created in the same dialog measured its rate
   * from the FIRST pass and reported an ETA tens of times too long.
   */
  useEffect(() => {
    setName(suggestedName)
    setFormat('v1')
    setPieceChoice('')
    setStartedAt(0)
  }, [suggestedName])
  useEffect(() => { if (state.stage === 'hashing' && !startedAt) setStartedAt(Date.now()) }, [state.stage, startedAt])

  const options: CreateOptions = useMemo(() => ({
    name,
    trackers: trackerText.split('\n'),
    webSeeds: webSeedText.split('\n'),
    comment,
    source: sourceTag,
    pieceLength: pieceChoice ? Number(pieceChoice) : undefined,
    format,
    private: isPrivate,
  }), [name, trackerText, webSeedText, comment, sourceTag, pieceChoice, format, isPrivate])

  /** Both controls re-plan, and each has to pass the OTHER's current value or it would undo it. */
  const replanWith = (next: { pieceLength?: number, format?: TorrentFormat }) => create.replan({
    pieceLength: pieceChoice ? Number(pieceChoice) : undefined,
    format,
    ...next,
  })

  const working = state.stage === 'reading' || state.stage === 'hashing' || state.stage === 'checking'
    || state.stage === 'copying' || state.stage === 'adding'
  const eta = state.progress && startedAt ? hashEta(state.progress, Date.now() - startedAt) : undefined
  const done = state.progress ? state.progress.hashedBytes / Math.max(1, state.progress.totalBytes) : 0
  const copied = state.copy ? state.copy.copiedBytes / Math.max(1, state.copy.totalBytes) : 0
  const starting = intl.formatMessage({ id: 'starting…', defaultMessage: 'starting…' })

  return (
    <Modal labelledBy="create-torrent-title" onClose={working ? create.cancel : onClose} initialFocus={first}>
      <div css={style}>
      <div className="card">
        <header>
          <h2 id="create-torrent-title">{intl.formatMessage({ id: 'Create a torrent', defaultMessage: 'Create a torrent' })}</h2>
        </header>

        <div className="body">
          {state.stage === 'idle' && <p>{intl.formatMessage({ id: 'Pick a file or a folder to share.', defaultMessage: 'Pick a file or a folder to share.' })}</p>}

          {state.stage === 'reading' && (
            <p>
              {state.filesFound
                ? intl.formatMessage({
                  id: '{count, plural, one {Reading the folder, {count} files so far…} other {Reading the folder, {count} files so far…}}',
                  defaultMessage: '{count, plural, one {Reading the folder, {count} files so far…} other {Reading the folder, {count} files so far…}}',
                }, { count: state.filesFound })
                : intl.formatMessage({ id: 'Reading the folder…', defaultMessage: 'Reading the folder…' })}
            </p>
          )}

          {(state.stage === 'ready' || state.stage === 'error') && state.plan && (
            <>
              <div className="facts">
                <div className="fact">
                  <span className="label">{intl.formatMessage({ id: 'Files', defaultMessage: 'Files' })}</span>
                  {/* the person's own files. A hybrid torrent's plan also holds the pad files, which
                      are zeroes Ripple inserted and nobody picked. */}
                  <span className="value">{contentFiles(state.plan).length}</span>
                </div>
                <div className="fact">
                  <span className="label">{intl.formatMessage({ id: 'Total size', defaultMessage: 'Total size' })}</span>
                  <span className="value">{getHumanReadableByteString(state.plan.totalBytes)}</span>
                </div>
                <div className="fact">
                  <span className="label">{intl.formatMessage({ id: 'Pieces', defaultMessage: 'Pieces' })}</span>
                  {/* The count comes from the same `plan()` the encoder uses, re-run on every
                      change, rather than from a second `ceil(size / length)` here. Two copies of
                      that look impossible to get wrong until one is fed the size before
                      exclusions and the screen and the torrent disagree. */}
                  <span className="value">{state.plan.pieceCount}</span>
                </div>
                {state.plan.paddedBytes > state.plan.totalBytes && (
                  <div className="fact">
                    <span className="label">{intl.formatMessage({ id: 'Padding', defaultMessage: 'Padding' })}</span>
                    {/* Named rather than folded into the total, because it is bytes the swarm carries
                        that nobody asked for. One piece per file at worst, so a pick of many small
                        files can pay a real fraction and this is where somebody would notice. */}
                    <span className="value">
                      {getHumanReadableByteString(state.plan.paddedBytes - state.plan.totalBytes)}
                    </span>
                  </div>
                )}
              </div>

              <label className="field">
                <span>{intl.formatMessage({ id: 'Format', defaultMessage: 'Format' })}</span>
                <select
                  value={format}
                  onChange={(event) => {
                    const chosen = event.target.value as TorrentFormat
                    setFormat(chosen)
                    replanWith({ format: chosen })
                  }}
                >
                  <option value="v1">{intl.formatMessage({ id: 'v1', defaultMessage: 'v1' })}</option>
                  <option value="hybrid">{intl.formatMessage({ id: 'Hybrid, v1 and v2', defaultMessage: 'Hybrid, v1 and v2' })}</option>
                  <option value="v2">{intl.formatMessage({ id: 'v2 only', defaultMessage: 'v2 only' })}</option>
                </select>
              </label>

              {/*
                * Said here rather than left to be discovered, because the torrent is correct and the
                * loss happens at the other end. See `dropsFolderName`: a v2 file tree holding one file
                * at its root has nowhere to put the folder name, and every libtorrent client reads it
                * the same way. Hybrid carries the same content and keeps the folder.
                */}
              {dropsFolderName(state.plan) && (
                <p className="warn">
                  {intl.formatMessage({ id: 'v2 loses the folder name {name}. Hybrid keeps it.', defaultMessage: 'v2 loses the folder name {name}. Hybrid keeps it.' }, {
                    name: <strong>{state.plan.name}</strong>,
                  })}
                </p>
              )}

              <label className="field">
                <span>{intl.formatMessage({ id: 'Piece size', defaultMessage: 'Piece size' })}</span>
                <select
                  value={pieceChoice}
                  onChange={(event) => {
                    setPieceChoice(event.target.value)
                    replanWith({ pieceLength: event.target.value ? Number(event.target.value) : undefined })
                  }}
                >
                  <option value="">{intl.formatMessage({ id: 'Auto ({size})', defaultMessage: 'Auto ({size})' }, { size: binaryBytes(state.plan.pieceLength, intl) })}</option>
                  {PIECE_CHOICES.map((size) => (
                    <option key={size} value={size}>{binaryBytes(size, intl)}</option>
                  ))}
                </select>
              </label>

              {state.truncated && (
                <p className="warn">{intl.formatMessage({ id: 'Too many files for one torrent. Pick a smaller folder.', defaultMessage: 'Too many files for one torrent. Pick a smaller folder.' })}</p>
              )}
              {state.skipped.length > 0 && (
                <details>
                  <summary className="faint">
                    {intl.formatMessage({ id: '{count, plural, one {{count} left out} other {{count} left out}}', defaultMessage: '{count, plural, one {{count} left out} other {{count} left out}}' }, { count: state.skipped.length })}
                  </summary>
                  <div className="skipped">{state.skipped.map(wordsOf).map((path) => <div key={path}>{path}</div>)}</div>
                </details>
              )}

              <label className="field">
                <span>{intl.formatMessage({ id: 'Name', defaultMessage: 'Name' })}</span>
                <input type="text" value={name} onChange={(event) => setName(event.target.value)}/>
              </label>

              <label className="field">
                <span>{intl.formatMessage({ id: 'Trackers, one per line', defaultMessage: 'Trackers, one per line' })}</span>
                <textarea value={trackerText} onChange={(event) => setTrackerText(event.target.value)}/>
              </label>

              <details>
                <summary className="faint">{intl.formatMessage({ id: 'Web seeds, comment, source', defaultMessage: 'Web seeds, comment, source' })}</summary>
                <div className="more">
                  <label className="field">
                    <span>{intl.formatMessage({ id: 'Web seed URLs, one per line', defaultMessage: 'Web seed URLs, one per line' })}</span>
                    <textarea value={webSeedText} onChange={(event) => setWebSeedText(event.target.value)}/>
                  </label>
                  <label className="field">
                    <span>{intl.formatMessage({ id: 'Comment', defaultMessage: 'Comment' })}</span>
                    <input type="text" value={comment} onChange={(event) => setComment(event.target.value)}/>
                  </label>
                  <label className="field">
                    <span>{intl.formatMessage({ id: 'Source', defaultMessage: 'Source' })}</span>
                    <input type="text" value={sourceTag} onChange={(event) => setSourceTag(event.target.value)}/>
                  </label>
                </div>
              </details>

              <label className="check">
                <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)}/>
                <span>{intl.formatMessage({ id: 'Private', defaultMessage: 'Private' })}</span>
              </label>

              {state.error && <p className="warn">{state.error}</p>}

              {/* The copy is the largest thing this dialog can set off, so its size is on screen
                  before the button is pressed rather than after. Only ever shown for a pick that
                  cannot be re-opened, which is the only pick anything is copied for. `null` is the
                  measurement not being back yet, and says nothing rather than guessing. */}
              {state.room?.kind === 'fits' && state.plan && (
                <p className="faint">
                  {intl.formatMessage({ id: 'Keeps a {size} copy in browser storage.', defaultMessage: 'Keeps a {size} copy in browser storage.' }, { size: getHumanReadableByteString(state.plan.totalBytes) })}
                </p>
              )}
              {state.room?.kind === 'short' && state.plan && (
                <p className="warn">
                  {intl.formatMessage({
                    id: '{size} short of room for a copy. Sharing stops when this tab closes.',
                    defaultMessage: '{size} short of room for a copy. Sharing stops when this tab closes.',
                  }, { size: getHumanReadableByteString(state.room.shortBy) })}
                </p>
              )}
              {state.room?.kind === 'unsafe' && (
                <p className="warn">{intl.formatMessage({ id: 'A file name is too long to copy. Sharing stops when this tab closes.', defaultMessage: 'A file name is too long to copy. Sharing stops when this tab closes.' })}</p>
              )}
              {state.room?.kind === 'unknown' && (
                <p className="faint">{intl.formatMessage({ id: 'Sharing stops when this tab closes.', defaultMessage: 'Sharing stops when this tab closes.' })}</p>
              )}
            </>
          )}

          {(state.stage === 'hashing' || state.stage === 'checking') && (
            <>
              <p>
                {state.stage === 'checking'
                  ? intl.formatMessage({ id: 'Checking the files…', defaultMessage: 'Checking the files…' })
                  : intl.formatMessage({ id: 'Hashing the files…', defaultMessage: 'Hashing the files…' })}
              </p>
              <div className="bar"><div style={{ width: `${Math.round(done * 100)}%` }}/></div>
              <p className="faint">
                {!state.progress
                  ? starting
                  : eta === undefined
                    ? intl.formatMessage({ id: '{done} of {total} · {name}', defaultMessage: '{done} of {total} · {name}' }, {
                      done: getHumanReadableByteString(state.progress.hashedBytes),
                      total: getHumanReadableByteString(state.progress.totalBytes),
                      name: state.progress.path,
                    })
                    : intl.formatMessage({ id: '{done} of {total} · about {eta} left · {name}', defaultMessage: '{done} of {total} · about {eta} left · {name}' }, {
                      done: getHumanReadableByteString(state.progress.hashedBytes),
                      total: getHumanReadableByteString(state.progress.totalBytes),
                      eta: writeDuration({ seconds: eta }),
                      name: state.progress.path,
                    })}
              </p>
            </>
          )}

          {state.stage === 'copying' && (
            <>
              <p>{intl.formatMessage({ id: 'Copying to browser storage…', defaultMessage: 'Copying to browser storage…' })}</p>
              <div className="bar">
                <div style={{ width: `${Math.round(copied * 100)}%` }}/>
              </div>
              <p className="faint">
                {!state.copy
                  ? starting
                  : state.copy.name
                    ? intl.formatMessage({ id: '{done} of {total} · {name}', defaultMessage: '{done} of {total} · {name}' }, {
                      done: getHumanReadableByteString(state.copy.copiedBytes),
                      total: getHumanReadableByteString(state.copy.totalBytes),
                      name: state.copy.name,
                    })
                    : intl.formatMessage({ id: '{done} of {total}', defaultMessage: '{done} of {total}' }, {
                      done: getHumanReadableByteString(state.copy.copiedBytes),
                      total: getHumanReadableByteString(state.copy.totalBytes),
                    })}
              </p>
            </>
          )}

          {state.stage === 'adding' && <p>{intl.formatMessage({ id: 'Adding…', defaultMessage: 'Adding…' })}</p>}

          {state.stage === 'done' && state.built && (
            <>
              {/* `data-outcome` names which kind of sharing this turned out to be: one re-opens its
                  files after a reload, one survives on Ripple's own copy, one lasts as long as the tab */}
              <p data-outcome={state.reopenable ? 'reopenable' : state.room?.kind === 'fits' ? 'copied' : 'tab'}>
                {intl.formatMessage({ id: '{name} is being shared.', defaultMessage: '{name} is being shared.' }, { name: <strong>{state.built.plan.name}</strong> })}
              </p>
              <p className="faint">
                {intl.formatMessage({ id: 'Info hash {hash}', defaultMessage: 'Info hash {hash}' }, { hash: <code>{state.built.infoHash}</code> })}
              </p>
              {/* only when it is a SECOND name for the same torrent. A v2-only torrent's identity IS
                  its v2 hash, so a second line would print the same string twice. */}
              {state.built.infoHashV2 && state.built.infoHashV2 !== state.built.infoHash && (
                <p className="faint">
                  {intl.formatMessage({ id: 'v2 info hash {hash}', defaultMessage: 'v2 info hash {hash}' }, { hash: <code>{state.built.infoHashV2}</code> })}
                </p>
              )}
              {!state.reopenable && state.room?.kind !== 'fits' && (
                <p className="faint">{intl.formatMessage({ id: 'Sharing stops when this tab closes or reloads.', defaultMessage: 'Sharing stops when this tab closes or reloads.' })}</p>
              )}
            </>
          )}

          {state.stage === 'error' && !state.plan && <p className="warn">{state.error}</p>}
        </div>

        {/* The footer is where the action lives in every other dialog here, so it is where somebody
            looks for it. Its contents change with the stage; its position does not. */}
        <footer>
          {state.stage === 'idle' && (
            <>
              <button type="button" onClick={onClose}>{intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}</button>
              {/* ONE PAIR OF BUTTONS, on every engine. This used to fork: the handle pickers where
                  the window carried them, and a pair of labels wrapping `<input type="file">` where
                  it did not, which is two routes to maintain and two sets of copy to keep true.
                  `@banou/ponyfill` opens the input itself where an engine has no picker, so there is
                  one call, one return type, and nothing here that names a browser. */}
              <button type="button" onClick={() => void create.pickFile()}>{intl.formatMessage({ id: 'Choose a file', defaultMessage: 'Choose a file' })}</button>
              <button ref={first} className="go" type="button" onClick={() => void create.pickFolder()}>
                {intl.formatMessage({ id: 'Choose a folder', defaultMessage: 'Choose a folder' })}
              </button>
            </>
          )}

          {state.stage === 'reading' && <button ref={first} type="button" onClick={create.cancel}>{intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}</button>}

          {(state.stage === 'ready' || state.stage === 'error') && state.plan && (
            <>
              <button type="button" onClick={create.reset}>{intl.formatMessage({ id: 'Pick something else', defaultMessage: 'Pick something else' })}</button>
              <button ref={first} className="go" type="button" onClick={() => void create.publish(options)}>
                {intl.formatMessage({ id: 'Create and start sharing', defaultMessage: 'Create and start sharing' })}
              </button>
            </>
          )}

          {/* `copying` too: it is the longest step for a large pick, and a dialog that offers no way
              out of its longest step is the one somebody force-reloads out of. Nothing has been added
              at this point, so cancelling costs only the bytes written, which the orphan sweep takes
              back on its own. */}
          {(state.stage === 'hashing' || state.stage === 'checking' || state.stage === 'copying') && (
            <button ref={first} type="button" onClick={create.cancel}>{intl.formatMessage({ id: 'Cancel', defaultMessage: 'Cancel' })}</button>
          )}

          {state.stage === 'done' && state.built && (
            <>
              <button type="button" onClick={onClose}>{intl.formatMessage({ id: 'Close', defaultMessage: 'Close' })}</button>
              <button type="button" onClick={create.reset}>{intl.formatMessage({ id: 'Create another', defaultMessage: 'Create another' })}</button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(state.built!.magnet)
                    .then(() => onToast(intl.formatMessage({ id: 'Magnet link copied', defaultMessage: 'Magnet link copied' })))
                    .catch(() => onToast(intl.formatMessage({ id: 'Could not copy the link', defaultMessage: 'Could not copy the link' })))
                }}
              >
                {intl.formatMessage({ id: 'Copy magnet', defaultMessage: 'Copy magnet' })}
              </button>
              <button
                ref={first}
                className="go"
                type="button"
                onClick={() => { onShare(state.built!.magnet); onClose() }}
              >
                {intl.formatMessage({ id: 'Get a share link', defaultMessage: 'Get a share link' })}
              </button>
            </>
          )}

          {state.stage === 'error' && !state.plan && (
            <button ref={first} type="button" onClick={create.reset}>{intl.formatMessage({ id: 'Try again', defaultMessage: 'Try again' })}</button>
          )}
        </footer>
      </div>
      </div>
    </Modal>
  )
}
