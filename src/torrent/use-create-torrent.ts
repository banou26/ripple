import { useCallback, useEffect, useRef, useState } from 'react'
import { del, get, set } from 'idb-keyval'

import type { Built, CreateOptions } from './create-source'
import type { HashProgress } from './hash-pieces'
import type { Persisted } from './library'
import type { PickedFile } from './walk-source'
import type { TorrentClient } from './client'
import type { TorrentFormat, TorrentPlan } from './make-torrent'

import { DEFAULT_TRACKERS, buildTorrent, optionsError } from './create-source'
import { HashCancelled, hashPieces } from './hash-pieces'
import { plan } from './make-torrent'
import { changedSince, pickedFile, readPicked, walkDirectory } from './walk-source'

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
export type CreateStage = 'idle' | 'reading' | 'ready' | 'hashing' | 'checking' | 'adding' | 'done' | 'error'

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
}

const IDLE: CreateState = {
  stage: 'idle', plan: null, skipped: [], truncated: false, progress: null, error: null, built: null, filesFound: 0,
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

export const createSupported = () =>
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
    root: FileSystemDirectoryHandle | FileSystemFileHandle
    files: PickedFile[]
    single: boolean
  } | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const fail = (error: unknown) => {
    if (error instanceof HashCancelled || (error as Error)?.name === 'WalkCancelled') { setState(IDLE); return }
    setState((prev) => ({ ...prev, stage: 'error', error: String((error as Error)?.message ?? error) }))
  }

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
      source.current = { root, files: read.files, single: read.single }
      // planned here rather than at publish time so the file count, the total and the piece count
      // are on screen BEFORE anybody agrees to anything. No piece length yet: the dialog re-plans
      // through `replan` below once somebody chooses one.
      const built = plan({
        name: root.name,
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
    } catch (error) { fail(error) }
  }, [])

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
      await set(sourceKey(out.infoHash), pick.root)
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
        name: pick.root.name,
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

  return { supported: createSupported(), state, suggestedName, pickFolder, pickFile, publish, replan, cancel, reset }
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
