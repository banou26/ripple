/**
 * Enough of a browser worker to import `worker.ts` and watch what it posts.
 *
 * Three fixes in `worker.ts` are statements in one control flow and are not extractable into
 * anything a pure test can call: reporting the origin's space from a `finally` rather than from the
 * happy path, clearing the measured figure BEFORE an eviction rather than after it, and folding the
 * reserved hashes into the orphan sweep's `listedHashes`. Each of those is a fact about the worker
 * itself, so the worker is what the test has to run.
 *
 * What it needs is small: a `self` that collects messages, a `navigator.storage` that answers with
 * whatever figures the case is about, and mocks for the four modules that would otherwise need a
 * real engine and a real IndexedDB.
 *
 * ONE WORKER IMPORT PER TEST FILE. The module holds top-level state and starts intervals that
 * outlive `vi.resetModules()`, so a second import in the same file leaves the first instance still
 * ticking into the same collector.
 */

/** A directory handle with just the surface `opfsAvailable`, `measureOpfsBytes` and the sweep use. */
export type FakeDir = {
  kind: 'directory'
  name: string
  children: Map<string, FakeDir | FakeFile>
  removed: string[]
  values: () => AsyncIterable<FakeDir | FakeFile>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<FakeDir>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FakeFile>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
}

export type FakeFile = {
  kind: 'file'
  name: string
  size: number
  getFile: () => Promise<{ size: number }>
  createSyncAccessHandle: () => Promise<{ close: () => void }>
}

export const fakeFile = (name: string, size = 0): FakeFile => ({
  kind: 'file',
  name,
  size,
  getFile: async () => ({ size }),
  createSyncAccessHandle: async () => ({ close: () => {} }),
})

export const fakeDir = (name: string, children: (FakeDir | FakeFile)[] = []): FakeDir => {
  const map = new Map(children.map((child) => [child.name, child]))
  const dir: FakeDir = {
    kind: 'directory',
    name,
    children: map,
    removed: [],
    values: () => ({
      async *[Symbol.asyncIterator] () { for (const child of [...map.values()]) yield child },
    }),
    getDirectoryHandle: async (childName, options) => {
      const found = map.get(childName)
      if (found && found.kind === 'directory') return found
      if (found) throw new Error(`${childName} is a file`)
      if (!options?.create) throw new Error(`no directory ${childName}`)
      const made = fakeDir(childName)
      map.set(childName, made)
      return made
    },
    getFileHandle: async (childName, options) => {
      const found = map.get(childName)
      if (found && found.kind === 'file') return found
      if (found) throw new Error(`${childName} is a directory`)
      if (!options?.create) throw new Error(`no file ${childName}`)
      const made = fakeFile(childName)
      map.set(childName, made)
      return made
    },
    removeEntry: async (childName) => {
      if (!map.delete(childName)) throw new Error(`no entry ${childName}`)
      dir.removed.push(childName)
    },
  }
  return dir
}

export type Posted = { type: string, [key: string]: unknown }

export type WorkerRig = {
  posted: Posted[]
  /** Every message of one type, in the order the worker posted them. */
  of: (type: string) => Posted[]
  /** Hand the worker a message the way the page's `postMessage` would. */
  send: (message: unknown) => void
  root: FakeDir
}

/**
 * Install the globals `worker.ts` reads, and return what it says back.
 *
 * `Object.defineProperty` for `navigator`, not assignment: node defines it as a getter, and
 * `globalThis.navigator = ...` throws "Cannot set property navigator of #<Object> which has only a
 * getter" rather than doing nothing, which reads as a broken test rather than a wrong approach.
 */
export const installWorkerGlobals = (
  { estimate, root }: { estimate: () => Promise<{ usage?: number, quota?: number }>, root?: FakeDir },
): WorkerRig => {
  const posted: Posted[] = []
  const listeners = new Map<string, ((event: { data: unknown }) => void)[]>()
  const dir = root ?? fakeDir('')

  const self = {
    postMessage: (message: Posted) => { posted.push(message) },
    addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener: () => {},
  }

  for (const [name, value] of [
    ['self', self],
    ['navigator', { storage: { estimate, getDirectory: async () => dir } }],
  ] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }

  return {
    posted,
    of: (type) => posted.filter((message) => message.type === type),
    send: (message) => { for (const fn of listeners.get('message') ?? []) fn({ data: message }) },
    root: dir,
  }
}

/** A libtorrent session that answers everything `init` and `snapshot` ask of it. */
/**
 * What a test reads back off a session, stated rather than inferred.
 *
 * `fakeSession` PUSHES into `sessions`, so inferring the array's type from the function's return
 * type is circular whichever order the two are declared in: TS2502, and moving the declaration does
 * not help. Naming the one member tests actually use, and leaving the rest open, breaks the cycle
 * and keeps `removed` typed, which is the only part an assertion touches.
 */
export type FakeSession = { removed: number[] } & Record<string, unknown>

export const fakeSession = (over: Partial<Record<string, unknown>> = {}): FakeSession => {
  let next = 1
  const removed: number[] = []
  const session: FakeSession = {
    removed,
    tick: () => {},
    popAlerts: () => [],
    postStatus: () => {},
    setRateLimits: () => {},
    reachable: () => 'unknown',
    addMagnet: () => next++,
    addTorrentFile: () => next++,
    addTorrentWithResume: () => next++,
    removeTorrent: (handle: number) => { removed.push(handle) },
    // `snapshot()` calls all three for every handle, and a throw here kills `init` before the budget
    // pass ever runs, which is how a test of an ABSENT message passes while measuring nothing
    files: () => null,
    status: () => null,
    bitfield: () => null,
    peers: () => [],
    trackers: () => [],
    lastPeers: () => [],
    lastTrackers: () => [],
    setPriorities: () => {},
    setFlags: () => {},
    pause: () => {},
    resume: () => {},
    saveResume: () => {},
    ...over,
  }
  sessions.push(session)
  return session
}

/**
 * Every session the mocked engine has handed out, newest last.
 *
 * The mock factory builds the session and the test has to read what was done to it, and the two
 * cannot pass an object between them: the factory runs when `worker.ts` is imported, long after the
 * test file's own top level. So it is registered here, in the module both of them import.
 *
 * AFTER `fakeSession` rather than before it: typing this from its return type while that function
 * is still ahead of us is circular, and TS reports it as TS2502 rather than at the point of use.
 */
export const sessions: FakeSession[] = []