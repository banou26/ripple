import { useCallback, useEffect, useRef, useState } from 'react'
import { del, get, set } from 'idb-keyval'

import type { Built, CreateOptions } from './create-source'
import type { HashProgress } from './hash-pieces'
import type { Persisted } from './library'
import type { PickedFile } from './walk-source'
import type { TorrentClient } from './client'
import type { TorrentFormat, TorrentPlan } from './make-torrent'

import type { CopyProgress, CopyRoom } from './copy-source'

import { DEFAULT_TRACKERS, buildTorrent, optionsError } from './create-source'
import { HashCancelled, hashPieces } from './hash-pieces'
import { copyPickIntoBrowserStorage, measureRoomForCopy } from './copy-source'
import { plan } from './make-torrent'
import { changedSince, filesFromList, pickedFile, readPicked, walkDirectory } from './walk-source'

/**
 * Creating a torrent from something on this device, and keeping it seeding across loads.
 *
 * The pieces this joins are all tested on their own: `walk-source.ts` reads the pick,
 * `make-torrent.ts` decides what the torrent says, `hash-pieces.ts` walks the bytes, and
 * `create-source.ts` assembles and checks the result. What is here is the part that needs a browser:
 * the pickers, a permission grant that does not survive a reload, and the durable handle.
 *
 * IT RUNS IN THE PAGE, not in a worker. Hashing is `crypto.subtle.digest`, which Chrome runs off the
 * main thread, plus `slice().arrayBuffer()` reads, which are async, so the only main-thread work is
 * copying each chunk into the piece buffer. A dedicated worker would take that copy off the main
 * thread too and is the right answer for a very large pick; it is not here because the handles, the
 * gesture and the dialog are all in the page, and a worker would add a protocol before it added a
 * measurement showing the copies matter.
 */

/** Where the flow is. `ready` is a pick that has been read and is waiting to be confirmed. */
export type CreateStage =
  'idle' | 'reading' | 'ready' | 'hashing' | 'checking' | 'copying' | 'adding' | 'done' | 'error'

export type CreateState = {
  stage: CreateStage
  /** What the pick turned out to be, known before any hashing so it can be confirmed first. */
  plan: TorrentPlan | null
  /** Files left out of the pick, so the dialog can say so rather than quietly shrinking the torrent. */
  skipped: string[]
  truncated: boolean
  progress: HashProgress | null
  error: string | null
  /** Set once it is published, for the link and the .torrent download. */
  built: Built | null
  filesFound: number
  /**
   * Whether this pick's bytes will be kept in browser storage, and if not, by how much it misses.
   *
   * Only ever set for a pick that cannot be re-opened, which is the input route. Measured as soon as
   * the pick is read, so the dialog can say what will happen BEFORE anybody agrees to it rather than
   * reporting it afterwards. Null on the handle route, where nothing is copied and the question does
   * not arise.
   */
  room: CopyRoom | null
  /** Where the copy has got to, while `stage` is `copying`. */
  copy: CopyProgress | null
}

const IDLE: CreateState = {
  stage: 'idle',
  plan: null,
  skipped: [],
  truncated: false,
  progress: null,
  error: null,
  built: null,
  filesFound: 0,
  room: null,
  copy: null,
}

const sourceKey = (infoHash: string) => 'ripple:source:' + infoHash

type PermissionCapable = FileSystemHandle & {
  queryPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>
}

/**
 * `read`, never `readwrite`, and the same mode on the way back.
 *
 * The storage backend refuses every write to a source in code; asking for read only means the
 * browser refuses it too, so the guarantee does not rest on Ripple being correct. Querying a
 * different mode than was requested is the trap here: the request succeeds, the query still answers
 * `prompt`, and the row sits at "Waiting for access" with a button that appears to do nothing.
 */
const READ: { mode: 'read' } = { mode: 'read' }

const queryRead = async (handle: FileSystemHandle): Promise<PermissionState> =>
  await (handle as PermissionCapable).queryPermission?.call(handle, READ) ?? 'granted'

const requestRead = async (handle: FileSystemHandle): Promise<boolean> =>
  await (handle as PermissionCapable).requestPermission?.call(handle, READ) === 'granted'

/**
 * Whether a torrent can be created here at all, which is everywhere.
 *
 * Creating needs BYTES, and a plain `<input type="file">` has been able to hand those over in every
 * browser for as long as there have been browsers. This used to require the handle pickers as well,
 * so Firefox got no Create button and no reason for its absence, and the gate was stricter than the
 * feature by a wide margin.
 */
export const createSupported = () => typeof window !== 'undefined'

/**
 * Whether this browser can hand back the SAME files after a reload.
 *
 * What a handle buys is not creating, it is re-opening: it survives a reload and can be re-granted,
 * so a torrent created from one keeps seeding across sessions. A `File` from an input is one
 * snapshot, readable for the life of the page and gone after it. That difference is the only thing
 * the two routes disagree about, and the dialog says which one is in force rather than hiding a
 * control.
 */
export const handlePickers = () =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'showOpenFilePicker' in window

type Picker = {
  showDirectoryPicker?: (options: { id?: string, mode?: 'read' }) => Promise<FileSystemDirectoryHandle>
  showOpenFilePicker?: (options: { id?: string, multiple?: boolean }) => Promise<FileSystemFileHandle[]>
}

/** Reads a pick into the list of files a torrent would be built from. */
const readPick = async (
  root: FileSystemDirectoryHandle | FileSystemFileHandle,
  { signal, onFound }: { signal?: AbortSignal, onFound?: (n: number) => void },
) => {
  if (root.kind === 'file') {
    const only = await pickedFile(root as FileSystemFileHandle)
    return { files: [only], skipped: [], truncated: false, single: true }
  }
  const walked = await walkDirectory(root as FileSystemDirectoryHandle, { signal, onFound })
  return { ...walked, single: false }
}

export type UseCreateTorrent = {
  supported: boolean
  state: CreateState
  /** The name the pick suggests, which the dialog offers as an editable default. */
  suggestedName: string
  pickFolder: () => Promise<void>
  pickFile: () => Promise<void>
  /**
   * The input route: a `FileList` from `<input type="file">`, with `folder` true when the input
   * carried `webkitdirectory`. Synchronous, because the list arrives complete.
   */
  pickFiles: (list: ArrayLike<File>, folder: boolean) => void
  /**
   * Whether a torrent made here can still be seeded after a reload.
   *
   * False on the input route, where the files are one snapshot the page cannot re-open. The dialog
   * says so before anybody creates anything, rather than after.
   */
  durableSources: boolean
  /** Hash, assemble, check, and hand it to the engine. */
  publish: (options: CreateOptions) => Promise<void>
  /**
   * Re-plan under a different piece length or format, so the numbers beside the controls are real.
   *
   * The format belongs here as much as the piece length: a hybrid torrent pads every file up to a
   * piece boundary, so the piece count and the padded size both move when it changes, and a screen
   * that recomputed only one of the two would disagree with the torrent it is about to make.
   */
  replan: (options?: { pieceLength?: number, format?: TorrentFormat }) => void
  cancel: () => void
  reset: () => void
}

export const useCreateTorrent = (client: TorrentClient): UseCreateTorrent => {
  const [state, setState] = useState<CreateState>(IDLE)
  const [suggestedName, setSuggestedName] = useState('')
  const source = useRef<{
    /** Null on the input route: there is no handle to store, so nothing can re-open it later. */
    root: FileSystemDirectoryHandle | FileSystemFileHandle | null
    /** Carried rather than read off `root`, which the input route does not have. */
    name: string
    files: PickedFile[]
    single: boolean
  } | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const fail = (error: unknown) => {
    // AbortError is the copy answering the same Cancel the other two answer with their own classes;
    // without it, pressing Cancel during the copy leaves the dialog on a red "the copy was cancelled"
    // as though something had gone wrong, rather than back where it started
    const name = (error as Error)?.name
    if (error instanceof HashCancelled || name === 'WalkCancelled' || name === 'AbortError') { setState(IDLE); return }
    setState((prev) => ({ ...prev, stage: 'error', error: String((error as Error)?.message ?? error) }))
  }

  /**
   * Everything after the pick, shared by both routes.
   *
   * Split out of `take` so the handle route and the input route cannot drift: both refusals below,
   * the plan, and the `ready` state are decided once, whatever handed over the files.
   */
  const accept = useCallback((
    read: { files: PickedFile[], skipped: string[], truncated: boolean, single: boolean },
    name: string,
    root: FileSystemDirectoryHandle | FileSystemFileHandle | null,
  ) => {
      if (!read.files.length) throw new Error('There are no files in there to put in a torrent')
      /*
       * A torrent of nothing is refused by libtorrent, in every format, so it is refused HERE.
       *
       * `plan()` allows a zero total on purpose, because a folder of empty files is a real thing to
       * describe. What cannot happen is publishing one: the engine answers the add with a refusal
       * and the flow ends on "The engine refused the torrent that was just built", after the whole
       * folder has been walked and hashed, saying nothing about the actual reason.
       */
      if (!read.files.reduce((sum, file) => sum + file.size, 0)) {
        throw new Error('Every file in there is empty, and a torrent needs something to share')
      }
      source.current = { root, name, files: read.files, single: read.single }
      // planned here rather than at publish time so the file count, the total and the piece count
      // are on screen BEFORE anybody agrees to anything. No piece length yet: the dialog re-plans
      // through `replan` below once somebody chooses one.
      const built = plan({
        name,
        files: read.files.map(({ path, size }) => ({ path, size })),
        single: read.single,
      })
      setState({
        ...IDLE,
        stage: 'ready',
        plan: built,
        skipped: read.skipped,
        truncated: read.truncated,
        filesFound: read.files.length,
      })
      /*
       * Asked now, not at publish time, because it changes what the dialog PROMISES.
       *
       * A pick that cannot be re-opened has its bytes copied into browser storage so the torrent
       * survives a reload, and that copy is the largest the app can make. Whether it fits decides
       * which of two true sentences the screen shows, and somebody deciding whether to start at all
       * is owed the one that applies to them. `root` is the whole test: handles re-open, snapshots
       * do not, and that is a property of this pick rather than of the browser.
       */
      if (!root) {
        // the paths as the torrent will carry them: the name is a path element too, for every file
        const paths = read.single ? [name] : read.files.map((file) => [name, ...file.path].join('/'))
        void measureRoomForCopy(built.totalBytes, paths).then((room) => {
          setState((prev) => (prev.stage === 'ready' ? { ...prev, room } : prev))
        })
      }
  }, [])

  const take = useCallback(async (root: FileSystemDirectoryHandle | FileSystemFileHandle) => {
    const controller = new AbortController()
    abort.current = controller
    setState({ ...IDLE, stage: 'reading' })
    setSuggestedName(root.name)
    try {
      const read = await readPick(root, {
        signal: controller.signal,
        onFound: (filesFound) => setState((prev) => (prev.stage === 'reading' ? { ...prev, filesFound } : prev)),
      })
      accept(read, root.name, root)
    } catch (error) { fail(error) }
  }, [accept])

  /**
   * The input route, which is what Firefox uses and what every browser could have used all along.
   *
   * `webkitdirectory` hands over a whole folder as a flat list with relative paths, so the folder
   * case works here too; `filesFromList` applies the same caps and junk rules the walk does. There is
   * no abort controller because there is nothing to abort: the list arrives complete and the work is
   * synchronous. `root` is null, which is what later makes this torrent unable to re-open itself.
   */
  const pickFiles = useCallback((list: ArrayLike<File>, folder: boolean) => {
    setState({ ...IDLE, stage: 'reading' })
    try {
      const read = filesFromList(list)
      const first = list[0]
      const name = folder
        ? (first?.webkitRelativePath?.split('/')[0] || 'torrent')
        : (first?.name ?? 'torrent')
      setSuggestedName(name)
      accept({ ...read, single: !folder }, name, null)
    } catch (error) { fail(error) }
  }, [accept])

  const pickFolder = useCallback(async () => {
    const picker = (window as unknown as Picker).showDirectoryPicker
    if (!picker) return
    // `mode: 'read'` so the browser itself refuses a write, rather than only this code refusing one
    const root = await picker({ id: 'ripple-source', mode: 'read' }).catch((error: unknown) => {
      if ((error as Error)?.name !== 'AbortError') fail(error)
      return null
    })
    if (root) await take(root)
  }, [take])

  const pickFile = useCallback(async () => {
    const picker = (window as unknown as Picker).showOpenFilePicker
    if (!picker) return
    const picked = await picker({ id: 'ripple-source', multiple: false }).catch((error: unknown) => {
      if ((error as Error)?.name !== 'AbortError') fail(error)
      return null
    })
    if (picked?.[0]) await take(picked[0])
  }, [take])

  const publish = useCallback(async (options: CreateOptions) => {
    const pick = source.current
    if (!pick) return
    const invalid = optionsError(options)
    if (invalid) { setState((prev) => ({ ...prev, stage: 'error', error: invalid })); return }

    const controller = new AbortController()
    abort.current = controller
    setState((prev) => ({ ...prev, stage: 'hashing', error: null, progress: null }))
    try {
      /*
       * The SAME options the review showed, piece length included.
       *
       * `buildTorrent` plans again from these, so a piece length threaded into only one of the two
       * would have the pass hash one geometry and the encoder describe another: the piece count would
       * not match the hashes and every peer would reject the torrent.
       */
      const built = plan({
        name: options.name,
        files: pick.files.map(({ path, size }) => ({ path, size })),
        single: pick.single,
        pieceLength: options.pieceLength,
        format: options.format,
      })
      const hashed = await hashPieces(built, (file, offset, length) => {
        const match = pick.files.find((candidate) => candidate.path.join('/') === file.path.join('/'))
        if (!match) throw new Error(`no handle for ${file.path.join('/')}`)
        return readPicked(match, offset, length)
      }, {
        signal: controller.signal,
        onProgress: (progress) => setState((prev) => ({ ...prev, progress })),
      })

      setState((prev) => ({ ...prev, stage: 'checking' }))
      /*
       * The freshness check, after hashing and before publishing.
       *
       * A file edited mid-pass gives pieces describing a mixture of two versions. Those hashes are
       * self-consistent, so it would publish without complaint and then fail every piece a peer
       * asked for, which is a failure that looks like a network problem and is not one.
       */
      const changed = await changedSince(pick.files)
      if (changed.length) {
        throw new Error(
          `${changed[0]!.path} changed while it was being read`
          + (changed.length > 1 ? `, along with ${changed.length - 1} more` : '')
          + '. Nothing was published; start again and it will match.',
        )
      }

      const out = await buildTorrent({ picked: pick.files, hashed, options, single: pick.single })

      /*
       * A pick that cannot be re-opened has its bytes KEPT, so the torrent goes on seeding.
       *
       * This is the whole of what a `FileSystemFileHandle` was buying: not the creating, which an
       * `<input type="file">` has always been able to do, but the RE-READING afterwards. A `File`
       * from an input is one snapshot, so a torrent built on it used to seed until the tab reloaded
       * and then sit in the library with its files gone. Copying into browser storage turns it into
       * an ordinary download that happens to be complete, with nothing to re-grant.
       *
       * Copy first, add second, and nothing in between. If the copy throws, the engine was never
       * told and the list has no row, so the whole thing is a retry rather than a torrent that
       * exists and cannot be served. The bytes a half-finished copy leaves under `/dl/<hash>` are
       * exactly what `runOrphanSweep` reclaims, so an abandoned attempt tidies itself up.
       *
       * When it does not FIT, the torrent is still made and still seeds; it seeds for as long as
       * this page is open, which is what the platform can promise without the copy. That is a
       * smaller thing than the person asked for and it is said on screen, rather than refusing to
       * create anything or copying most of a folder and failing at the end.
       */
      if (!pick.root) {
        const room = await measureRoomForCopy(
          out.plan.totalBytes,
          out.files.map((file) => file.name),
        )
        setState((prev) => ({ ...prev, room }))
        if (room.kind === 'fits') {
          setState((prev) => ({ ...prev, stage: 'copying', copy: null }))
          /*
           * The sweep is told to leave this directory alone BEFORE the first byte.
           *
           * `/dl/<infoHash>` with no list entry and no live handle is exactly what `planSweep`
           * deletes, recursively, and that is the state a copy-first flow is in for its whole
           * duration. A first sweep runs a minute after the worker starts and then every ten, plus
           * one from the budget pass whenever the origin reads full, which a multi-gigabyte copy is
           * itself the cause of. Minutes of exposure, invisible to any fixture small enough to copy
           * in milliseconds.
           *
           * Released by the WORKER once the entry exists, so there is no gap between the two. What
           * is released here is the failure path, where no entry is ever going to appear and the
           * partial directory genuinely is an orphan.
           */
          client.reserveStorage(out.infoHash, true)
          try {
            const { savePath } = await copyPickIntoBrowserStorage({
              built: out,
              signal: controller.signal,
              onProgress: (copy) => setState((prev) => ({ ...prev, copy })),
            })
            setState((prev) => ({ ...prev, stage: 'adding' }))
            /*
             * SLICED, because `addTorrentFile` TRANSFERS the buffer it is given.
             *
             * `out` is kept in `state.built` and read after this line, and a transferred buffer is
             * detached: `bytes` becomes a zero-length view, silently, with nothing throwing. Nothing
             * in the dialog reads it today, which is exactly why this would go unnoticed until
             * something did. `createSource` on the other branch is documented as not transferring
             * for the same reason, so this keeps both branches honest about the same hazard.
             *
             * `saveTo` travels WITH the add rather than in a `setLocation` after it, because that
             * handler is unqueued and a following command would run before the entry exists.
             */
            client.addTorrentFile(out.bytes.slice(), { savePath, saveTo: 'browser', created: true })
          } catch (error) {
            client.reserveStorage(out.infoHash, false)
            throw error
          }
          setState((prev) => ({ ...prev, stage: 'done', built: out, plan: out.plan }))
          return
        }
      }

      setState((prev) => ({ ...prev, stage: 'adding' }))
      /*
       * The handle is stored BEFORE the engine is told, and the ROOT is stored rather than the file
       * handles.
       *
       * Before, because a torrent the engine has and the page cannot find the source for on the next
       * load is the one state with no way out. The root, because that is what a permission grant
       * attaches to and what can be re-walked; re-walking also re-checks that the files are still
       * the ones the torrent describes, which storing the file handles would skip.
       */
      // nothing to store on the input route: a File cannot be re-opened after a reload
      if (pick.root) await set(sourceKey(out.infoHash), pick.root)
      client.createSource({
        infoHash: out.infoHash,
        magnet: out.magnet,
        bytes: out.bytes,
        handles: out.handles,
        name: out.plan.name,
        size: out.plan.totalBytes,
        format: out.format,
        pieceLength: out.plan.pieceLength,
        files: out.files,
      })
      setState((prev) => ({ ...prev, stage: 'done', built: out, plan: out.plan }))
    } catch (error) { fail(error) }
  }, [client])

  /**
   * Re-plan the pick under a different piece length, for the readout beside the selector.
   *
   * Cheap and synchronous: the walk is already done and `plan()` reads no disk, so the piece count
   * beside the control is the real one rather than an estimate computed a second way.
   */
  const replan = useCallback(({ pieceLength, format }: { pieceLength?: number, format?: TorrentFormat } = {}) => {
    const pick = source.current
    if (!pick) return
    try {
      const built = plan({
        name: pick.name,
        files: pick.files.map(({ path, size }) => ({ path, size })),
        single: pick.single,
        pieceLength,
        format,
      })
      setState((prev) => (prev.stage === 'ready' || prev.stage === 'error' ? { ...prev, plan: built } : prev))
    } catch { /* an invalid choice is reported by optionsError, not by throwing here */ }
  }, [])

  const cancel = useCallback(() => { abort.current?.abort() }, [])
  const reset = useCallback(() => { abort.current?.abort(); source.current = null; setState(IDLE) }, [])

  return {
    supported: createSupported(),
    durableSources: handlePickers(),
    state,
    suggestedName,
    pickFolder,
    pickFile,
    pickFiles,
    publish,
    replan,
    cancel,
    reset,
  }
}

export type WaitingSource = { entry: Persisted, name: string }

/**
 * Created torrents that are in the library but not in the engine, because their source is not
 * readable right now.
 *
 * This is the ordinary state after every reload, not a fault: a picker grant does not survive one,
 * and getting it back needs a user gesture. The worker deliberately does not add these on restore,
 * because adding one whose reads throw reaches libtorrent as a fatal disk error and shows up as a
 * red retrying row about a torrent where nothing is wrong except that nobody has clicked yet.
 */
export const useCreatedSources = (
  client: TorrentClient, list: Persisted[], owns: boolean,
): { waiting: WaitingSource[], allow: (infoHash: string) => Promise<boolean> } => {
  const [waiting, setWaiting] = useState<WaitingSource[]>([])
  const started = useRef(new Set<string>())

  const startFrom = useCallback(async (entry: Persisted, root: FileSystemDirectoryHandle | FileSystemFileHandle) => {
    const read = await readPick(root, {})
    /*
     * Planned in the format it was CREATED in, not in the default.
     *
     * The pads are part of the file list, so replanning a hybrid torrent as v1 produces a handle
     * array shorter than the one libtorrent indexes reads by, and every read past the first pad
     * would serve one file's bytes for another. Absent means v1, which is what every entry written
     * before the field existed is.
     */
    const built = plan({
      name: entry.name ?? root.name,
      files: read.files.map(({ path, size }) => ({ path, size })),
      single: read.single,
      format: entry.format ?? 'v1',
      // and at the SAME piece length, which is what fixes where the pads fall
      pieceLength: entry.pieceLength,
    })
    /*
     * The files have to be the SAME files, not merely present.
     *
     * Reads are served by index, so a file added to or removed from the folder since it was created
     * shifts every index after it and the torrent would serve one file's bytes for another. Nothing
     * would report an error; peers would simply reject every piece. Refusing to start is the honest
     * answer, and the row keeps saying it needs attention.
     */
    const want = (entry.size ?? built.totalBytes)
    if (built.totalBytes !== want) {
      throw new Error(`${root.name} now holds ${built.totalBytes} bytes where the torrent describes ${want}`)
    }
    const byPath = new Map(read.files.map((file) => [file.path.join('/'), file]))
    const handles = built.files.map((file) => {
      // a pad occupies its index and has no file; see `Built.handles` in create-source.ts
      if (file.pad) return null
      const match = byPath.get(file.path.join('/'))
      if (!match) throw new Error(`${file.path.join('/')} is no longer in ${root.name}`)
      return match.handle
    })
    client.startSource(entry.infoHash, handles)
    started.current.add(entry.infoHash)
  }, [client])

  useEffect(() => {
    if (!owns) return
    let cancelled = false
    void (async () => {
      const created = list.filter((entry) => entry.saveTo === 'source' && !started.current.has(entry.infoHash))
      const stillWaiting: WaitingSource[] = []
      for (const entry of created) {
        const root = await get<FileSystemDirectoryHandle | FileSystemFileHandle>(sourceKey(entry.infoHash)).catch(() => undefined)
        if (!root) continue
        if (await queryRead(root) === 'granted') {
          await startFrom(entry, root).catch(() => stillWaiting.push({ entry, name: root.name }))
          continue
        }
        stillWaiting.push({ entry, name: root.name })
      }
      if (!cancelled) setWaiting(stillWaiting)
    })()
    return () => { cancelled = true }
  }, [list, owns, startFrom])

  /**
   * Ask for one torrent's source back, from a click.
   *
   * ONE PER GESTURE, deliberately. `requestPermission` consumes the transient activation, so a loop
   * over several folders shows one prompt and then silently fails for the rest. A caller offering
   * this for many torrents has to offer many buttons, or walk them one press at a time.
   */
  const allow = useCallback(async (infoHash: string) => {
    const entry = list.find((candidate) => candidate.infoHash === infoHash)
    if (!entry) return false
    const root = await get<FileSystemDirectoryHandle | FileSystemFileHandle>(sourceKey(infoHash)).catch(() => undefined)
    if (!root) return false
    if (!(await requestRead(root))) return false
    try {
      await startFrom(entry, root)
      setWaiting((prev) => prev.filter((candidate) => candidate.entry.infoHash !== infoHash))
      return true
    } catch { return false }
  }, [list, startFrom])

  return { waiting, allow }
}

export const forgetSource = (infoHash: string) => del(sourceKey(infoHash)).catch(() => {})

export { DEFAULT_TRACKERS }
