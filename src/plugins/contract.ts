/** The protocol tag ripple connects a plugin with. A breaking change is `ripple-plugin@2`. */
export const PLUGIN_PROTOCOL = 'ripple-plugin@1'

/**
 * What a plugin may ask the person for, one switch per group of calls. Each starts off and the person turns it on per
 * plugin; a call whose switch is off rejects with `not-allowed`.
 */
export type Switch = 'read' | 'add' | 'change' | 'remove' | 'files' | 'folder' | 'peers' | 'network'

/** The switches this version of ripple offers. A plugin asking for another one is not asked about it yet. */
export const OFFERED_SWITCHES: readonly Switch[] = ['read', 'add', 'change']

/** The reasons a call rejects with, as its error's message. */
export type PluginError = 'not-allowed' | 'not-found' | 'unavailable' | 'invalid' | 'full'

export type PluginState = 'downloading' | 'seeding' | 'done' | 'paused' | 'waiting' | 'error' | 'missing'

export type PluginFile = { index: number, name: string, size: number, wanted: boolean, progress: number }

/**
 * A torrent as a plugin sees it. `magnet` carries the torrent's `xt` and `dn`, and its trackers only when the
 * .torrent this device keeps says it is not private. `trackers` are the trackers' origins alone, which hold no key.
 * `private` is null while no .torrent is kept here. `files` lists the person's own files, with the engine's index.
 */
export type PluginTorrent = {
  infoHash: string
  name: string
  size: number
  progress: number
  down: number
  up: number
  downloaded: number
  uploaded: number
  seedingSeconds: number
  addedAt: number | undefined
  state: PluginState
  groups: string[]
  private: boolean | null
  temporary: boolean
  location: 'browser' | 'folder' | 'source'
  magnet: string
  trackers: string[]
  files: PluginFile[] | undefined
}

export type PluginGroup = { id: string, name: string, infoHashes: string[] }

export type Source = { magnet: string } | { torrentFile: Uint8Array }

/** How a .torrent is added. A magnet takes none: choose its files once `changed` lists them. */
export type FileAddOptions = {
  files?: number[]
  firstLast?: boolean
  sequential?: boolean
  paused?: boolean
  top?: boolean
  location?: 'browser' | 'folder'
}

/** `already` for a torrent the library already keeps, which is left as it is. */
export type AddResult = { infoHash: string | null, outcome: 'added' | 'already' | 'failed' }

/**
 * The events `on` subscribes to. The four torrent events need the `read` switch. `changed` fires in every ripple tab,
 * at most once a second; `added`, `finished` and `removed` fire in the tab running the engine (`active`) only, and
 * never for what a load, an engine moving between tabs or the account's sync brings in.
 */
export type PluginEvents = {
  vpn: boolean
  locale: { locale: string, dir: 'ltr' | 'rtl' }
  active: boolean
  changed: PluginTorrent[]
  added: PluginTorrent
  finished: PluginTorrent
  removed: string
}

/** What ripple hands a plugin as its `remote`. Every call names torrents by info hash. */
export type Ripple = {
  version: 1
  locale: string
  dir: 'ltr' | 'rtl'
  /** Whether the VPN is on. While it is, every request the plugin makes to a third party goes through FKN's relay. */
  vpn: boolean
  /** Whether this tab runs the engine, where automatic work belongs. */
  active: boolean
  on: <E extends keyof PluginEvents>(event: E, listener: (value: PluginEvents[E]) => void) => Promise<() => void>
  /** Strings this plugin keeps on this device, 256 KB in all, kept across its versions. `null` deletes one. */
  store: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string | null) => Promise<void>
  }
  torrents: () => Promise<PluginTorrent[]>
  /** Answers a temporary torrent too, which `torrents` and the events leave out. */
  torrent: (infoHash: string) => Promise<PluginTorrent | null>
  groups: () => Promise<PluginGroup[]>
  /** The .torrent this device keeps, only when it says it is not private. */
  torrentFile: (infoHash: string) => Promise<Uint8Array | null>
  add: (source: Source, options?: FileAddOptions) => Promise<AddResult>
  pause: (infoHash: string) => Promise<void>
  resume: (infoHash: string) => Promise<void>
  forceStart: (infoHash: string) => Promise<void>
  recheck: (infoHash: string) => Promise<void>
  reannounce: (infoHash: string) => Promise<void>
  retry: (infoHash: string) => Promise<void>
  /** Downloads a torrent the library keeps and this device does not hold. */
  start: (infoHash: string) => Promise<void>
  /** Makes a temporary torrent one the library keeps. */
  keep: (infoHash: string) => Promise<void>
  setFiles: (infoHash: string, wanted: number[]) => Promise<void>
  setFirstLast: (infoHash: string, on: boolean) => Promise<void>
  setSequential: (infoHash: string, on: boolean) => Promise<void>
  moveInQueue: (infoHash: string, where: 'top' | 'up' | 'down' | 'bottom') => Promise<void>
  /** Only for a torrent whose kept .torrent says it is not private. Answers the urls the engine did not take. */
  addTrackers: (infoHash: string, urls: string[]) => Promise<string[]>
  /** Answers the new group's id. */
  createGroup: (name: string, infoHashes?: string[]) => Promise<string>
  renameGroup: (id: string, name: string) => Promise<void>
  /** Its torrents stay in the library. */
  deleteGroup: (id: string) => Promise<void>
  putInGroup: (id: string, infoHashes: string[]) => Promise<void>
  takeOutOfGroup: (id: string, infoHashes: string[]) => Promise<void>
}

/** What a plugin hands ripple as its payload. */
export type RipplePlugin = {
  /** The switches it would like on. The person is asked about each one, and each starts off. */
  asks: Switch[]
}
