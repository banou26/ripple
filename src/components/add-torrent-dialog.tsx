import { useRef, useState } from 'react'
import { css } from '@emotion/react'

import {
  BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, DANGER, EMPHASIS, EMPHASIS_HOVER, HOVER_WASH,
  SURFACE_BG,
  TEXT, TEXT_MUTED, TEXT_ON_LIGHT, WARN,
} from '../theme'

import { Modal } from './modal'
import { PersistOffer } from './persist-offer'

import type { AddChoices } from '../torrent/add-options'
import type { SaveLocation } from '../torrent/library'
import type { PersistState } from '../torrent/storage-permission'
import type { StorageRelief } from '../torrent/storage-relief'
import type { TorrentFile } from '../torrent/types'
import type { StorageUsage } from '../torrent/use-storage-usage'

import {
  choicesProblem, selectAll, selectedBytes, selectNone, toggleFile,
} from '../torrent/add-options'
import { persistOffer } from '../torrent/storage-permission'
import { reliefOffer } from '../torrent/storage-relief'
import { getHumanReadableByteString } from '../utils/bytes'

/**
 * What is in this torrent, and which of it do you want?
 *
 * Ripple's own Modal shell, matching the other two dialogs. Deliberately not `showModal()`: that
 * puts an element in the top layer, above @fkn/lib's broker frame, so an FKN prompt raised while
 * this was open could not be answered.
 *
 * It is the same dialog for two arrivals that feel different. A torrent the person added themselves
 * only gets it when they have asked for it, since it is friction in front of a question whose answer
 * is usually "all of it, now". A torrent arriving from another site through `/add` ALWAYS gets it,
 * because that one is a proposal from a stranger and this is where they agree to it. Hence
 * `external`, which changes the wording and hides the "do not ask again" checkbox: a setting that
 * could switch off the consent step for links from anywhere is not one worth offering.
 */

const style = css`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  .card {
    width: min(760px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: ${SURFACE_BG};
    /* The stronger edge, matching torrent-options-dialog. This card used to lean on a 64px drop
       shadow for its separation from the page; the shadow is gone, so the border does that job
       alone now, and it does it at any contrast setting. */
    border: 1px solid ${BORDER_STRONG};
    border-radius: 8px;
    color: ${TEXT};
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  header {
    padding: 20px 24px 14px;
    border-bottom: 1px solid ${BORDER};

    h2 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
      word-break: break-word;
    }

    .from {
      margin: 6px 0 0;
      font-size: 0.8rem;
      color: ${TEXT_MUTED};

      b { color: ${TEXT}; }
    }
  }

  .body {
    padding: 18px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;

    > label {
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: ${TEXT_MUTED};
    }
  }

  .files {
    border: 1px solid ${BORDER};
    border-radius: 6px;
    max-height: 260px;
    overflow-y: auto;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 12px;
    font-size: 0.85rem;
    border-bottom: 1px solid ${BORDER};
    cursor: pointer;

    &:last-child { border-bottom: none; }
    &:hover { background: ${HOVER_WASH}; }

    /* Native checkboxes, so leaving this out does not make them neutral: it hands them back to the
       UA, which under color-scheme: dark paints checked boxes in the platform accent, usually blue.
       A near-white accent also gets the tick rendered dark on light, the highest contrast the
       native control offers, which matters in a list that can run to hundreds of rows. */
    input { accent-color: ${EMPHASIS}; flex-shrink: 0; }

    .path {
      flex: 1;
      min-width: 0;
      word-break: break-word;
      .dir { color: ${TEXT_MUTED}; }
    }

    .size {
      flex-shrink: 0;
      color: ${TEXT_MUTED};
      font-variant-numeric: tabular-nums;
    }

    /* Muted rather than faint: this row is the point of the picker, it says what you are NOT
       taking, and the line-through has already eaten into the glyphs. The strike carries the
       meaning, so the colour only has to step down, not disappear. */
    &.off .path { color: ${TEXT_MUTED}; text-decoration: line-through; }
  }

  .bulk {
    display: flex;
    gap: 8px;
    align-items: center;

    .count {
      margin-left: auto;
      font-size: 0.8rem;
      color: ${TEXT_MUTED};
      font-variant-numeric: tabular-nums;
    }
  }

  .toggles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 10px 20px;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 0.85rem;
    cursor: pointer;
    line-height: 1.4;

    /* Same reason as the file rows above: an explicit neutral accent, or the UA paints these blue. */
    input { accent-color: ${EMPHASIS}; margin-top: 2px; flex-shrink: 0; }

    .hint {
      display: block;
      color: ${TEXT_MUTED};
      font-size: 0.78rem;
    }
  }

  .waiting {
    font-size: 0.85rem;
    color: ${TEXT_MUTED};
  }

  /* Outside .body on purpose. The body scrolls, and a torrent big enough to raise this notice is
     usually a torrent with a file list long enough to push it out of sight. It sits against the
     confirm row instead, where the figures are next to the button they are about. The margin
     matches the body's 24px so the notice lines up with everything above it. */
  .fit {
    margin: 0 24px 2px;
    padding: 12px 14px;
    border: 1px solid ${WARN};
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;

    strong { color: ${WARN}; font-weight: 600; }
    span { color: ${TEXT_MUTED}; line-height: 1.5; }
    button { align-self: flex-start; }
  }

  .problem {
    font-size: 0.85rem;
    color: ${DANGER};
  }

  footer {
    padding: 14px 24px 18px;
    border-top: 1px solid ${BORDER};
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;

    .spacer { margin-left: auto; }
  }

  button {
    font: inherit;
    font-size: 0.85rem;
    padding: 8px 18px;
    border-radius: 6px;
    border: 1px solid ${BORDER};
    background: ${CONTROL_BG};
    color: ${TEXT_MUTED};
    cursor: pointer;

    &:hover:not(:disabled) { background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; color: ${TEXT}; }
    &:disabled { opacity: 0.45; cursor: default; }

    /*
     * The primary is the light one. It sits next to Cancel and it is the only control here with a
     * disabled state, so the two must not collapse into the same object: emphasis is carried by a
     * near-white fill with dark text, which is the same dark-on-bright relationship the orange had.
     *
     * The hover block repeats the fill and the label on purpose. The button:hover:not(:disabled)
     * rule above carries two pseudo-classes to this rule's one class, so it out-specifies .primary
     * itself and would otherwise hand a hovered primary that fill's near-white label on top of a
     * near-white fill, which is text that is exactly as legible as no text at all.
     *
     * Nothing in the palette is brighter than EMPHASIS, so the fill steps DOWN on hover rather than
     * up, to EMPHASIS_HOVER. That value is not a local choice: it is calibrated in theme.ts to clear
     * the grey this same button composites to when it is disabled at 45%, because a hover that
     * happened to land there would make an enabled button look unavailable.
     */
    &.primary {
      background: ${EMPHASIS};
      border-color: ${EMPHASIS};
      color: ${TEXT_ON_LIGHT};
      font-weight: 600;

      &:hover:not(:disabled) {
        background: ${EMPHASIS_HOVER};
        border-color: ${EMPHASIS_HOVER};
        color: ${TEXT_ON_LIGHT};
      }
    }

    &.small { padding: 5px 12px; font-size: 0.78rem; }
  }
`

const FilePath = ({ path }: { path: string }) => {
  const cut = path.lastIndexOf('/')
  return cut < 0
    ? <>{path}</>
    : <><span className="dir">{path.slice(0, cut + 1)}</span>{path.slice(cut + 1)}</>
}

export const AddTorrentDialog = ({
  name, from, files, choices, onChoices, folderName, folderReady, external, onConfirm, onCancel, onNeverAsk,
  storage, relief, persist, onAskPersist,
}: {
  name: string
  /** the origin that linked here, for a torrent arriving from another site */
  from?: string | null
  /** empty until the metadata arrives, which is the only place a magnet's file list comes from */
  files: TorrentFile[]
  choices: AddChoices
  onChoices: (choices: AddChoices) => void
  folderName?: string
  folderReady?: boolean
  external?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** absent for an external add, where switching the step off is not on offer */
  onNeverAsk?: () => void
  /**
   * What the browser has measured, so the selection can be compared against the room left.
   *
   * OPTIONAL, and ABSENT HIDES THE NOTICE rather than guessing. `useStorageUsage` reports null until
   * its first read comes back, and there is no safe default for a limit: a made-up one tells someone
   * their download does not fit when nothing measured that, or stays silent while it does not. A
   * caller with no reading has nothing to say, so this says nothing.
   */
  storage?: StorageUsage | null
  /** The folder route, for the case where there is nothing left to ask the browser for. */
  relief?: StorageRelief
  persist?: PersistState
  /** Asks the browser for persistent storage. Runs on a press, never on a render. */
  onAskPersist?: () => void
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [neverAsk, setNeverAsk] = useState(false)


  const ready = files.length > 0
  const problem = ready ? choicesProblem(choices) : null
  const total = files.reduce((n, f) => n + f.size, 0)
  const selected = selectedBytes(choices, files)

  /**
   * Does what they have picked fit in what the browser is still allowing?
   *
   * Clamped at zero because a full origin can read back further used than its own limit: the used
   * figure is a walk of the file system (see `@banou/ponyfill`) and the limit is what the engine says it
   * allows, and the two are separate readings that can cross. Negative room is not a thing to put on
   * screen.
   *
   * Reported and never enforced. Confirm stays live below: eviction can free best-effort bytes, the
   * folder route moves finished downloads out, and on Firefox the ask beside this can raise the
   * limit itself. Someone who knows all that and adds it anyway is not making a mistake.
   */
  const room = storage ? Math.max(0, storage.limitBytes - storage.usedBytes) : null
  const shortfall = room !== null && selected > room ? { room } : null
  /** whether the offer below has a button, which is what decides if the folder route is shown here */
  const canAsk = !!persist && !!onAskPersist && persistOffer(persist).kind === 'ask'

  const set = (patch: Partial<AddChoices>) => onChoices({ ...choices, ...patch })

  const confirm = () => {
    if (problem || !ready) return
    if (neverAsk) onNeverAsk?.()
    onConfirm()
  }

  return (
    <Modal labelledBy="add-torrent-title" onClose={onCancel} initialFocus={cancelRef}>
      <div css={style}>
      <div className="card">
        <header>
          <h2 id="add-torrent-title">{name}</h2>
          <p className="from">
            {external
              ? <>{from ? <>Sent here by <b>{from}</b>. </> : <>Opened from a link. </>}Nothing is added until you say so.</>
              : <>Choose what to download before it starts.</>}
          </p>
        </header>

        <div className="body">
          <div className="group">
            <label>Files</label>
            {ready
              ? (
                <>
                  <div className="bulk">
                    <button className="small" onClick={() => onChoices(selectAll(choices, files.length))}>Select all</button>
                    <button className="small" onClick={() => onChoices(selectNone(choices))}>Select none</button>
                    <span className="count">
                      {getHumanReadableByteString(selected, true)} of {getHumanReadableByteString(total, true)}
                      {', '}{choices.files.length} of {files.length} files
                    </span>
                  </div>
                  <div className="files">
                    {files.map((file, index) => {
                      const on = choices.files.includes(index)
                      return (
                        <label className={on ? 'file' : 'file off'} key={file.name}>
                          <input type="checkbox" checked={on} onChange={() => onChoices(toggleFile(choices, index))}/>
                          <span className="path"><FilePath path={file.name}/></span>
                          <span className="size">{getHumanReadableByteString(file.size, true)}</span>
                        </label>
                      )
                    })}
                  </div>
                </>
              )
              : <p className="waiting">Reading the file list from the swarm...</p>}
            {problem && <p className="problem">{problem}</p>}
          </div>

          {folderReady && (
            <div className="group">
              <label>Where the files go</label>
              <div className="toggles">
                <label className="check">
                  <input
                    type="radio"
                    name="add-location"
                    checked={choices.location === 'browser'}
                    onChange={() => set({ location: 'browser' as SaveLocation })}
                  />
                  <span>
                    Browser storage
                    <span className="hint">Private to this browser, and counts against its quota.</span>
                  </span>
                </label>
                <label className="check">
                  <input
                    type="radio"
                    name="add-location"
                    checked={choices.location === 'folder'}
                    onChange={() => set({ location: 'folder' as SaveLocation })}
                  />
                  <span>
                    {folderName ?? 'Your folder'}
                    <span className="hint">Downloads in the browser, then moves there when it finishes.</span>
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="group">
            <label>How it starts</label>
            <div className="toggles">
              <label className="check">
                <input type="checkbox" checked={choices.start} onChange={(e) => set({ start: e.currentTarget.checked })}/>
                <span>
                  Start downloading
                  <span className="hint">Off adds it to the library and leaves it paused.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={choices.sequential} onChange={(e) => set({ sequential: e.currentTarget.checked })}/>
                <span>
                  Download in sequential order
                  <span className="hint">Front to back, so it can be watched early. Usually slower.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={choices.firstLast} onChange={(e) => set({ firstLast: e.currentTarget.checked })}/>
                <span>
                  Download first and last pieces first
                  <span className="hint">Grabs each file's head and tail early, where a player looks for the header and the index.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={choices.topOfQueue} onChange={(e) => set({ topOfQueue: e.currentTarget.checked })}/>
                <span>
                  Put it first
                  <span className="hint">Ahead of everything already waiting to run.</span>
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* `role=status` for the same reason the home page notice has it: the figures move on their
            own as downloads run, and ticking a file off the list can clear this without anybody
            acting on it. */}
        {shortfall && (
          <div className="fit" role="status">
            <strong>Bigger than the room left</strong>
            <span>
              This selection is {getHumanReadableByteString(selected, true)} and your browser is
              allowing Ripple {getHumanReadableByteString(shortfall.room, true)} more here. It can
              still be added: the download stops if the room runs out before it finishes.
            </span>
            {persist && onAskPersist && <PersistOffer persist={persist} onAsk={onAskPersist}/>}
            {/* The folder route takes the place of the button where there is no button to have,
                which is a browser that already answered. Never both: one route to read is the point
                of a notice sitting on top of a confirm row. */}
            {!canAsk && relief && <span>{reliefOffer(relief).detail}</span>}
          </div>
        )}

        <footer>
          {onNeverAsk && (
            <label className="check">
              <input type="checkbox" checked={neverAsk} onChange={(e) => setNeverAsk(e.currentTarget.checked)}/>
              <span>Do not ask again</span>
            </label>
          )}
          <span className="spacer"/>
          <button ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!ready || !!problem}>Add torrent</button>
        </footer>
      </div>
      </div>
    </Modal>
  )
}

export default AddTorrentDialog
