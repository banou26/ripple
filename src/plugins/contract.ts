// The ripple-plugin@1 contract, published as @banou/ripple's types: types only, importing nothing, so the published
// declaration stands alone (scripts/check-npm-package.mjs refuses one that declares a value or imports a module).

/**
 * What a plugin may ask the person for, one switch per group of calls. Each starts off and the person turns it on per
 * plugin; a call whose switch is off rejects with `not-allowed`.
 */
export type Switch = 'read' | 'add' | 'change' | 'remove' | 'files' | 'folder' | 'peers' | 'network'

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

/** `already` for a torrent the library already keeps; `declined` when the person closed `suggest` without adding it. */
export type AddResult = { infoHash: string | null, outcome: 'added' | 'declined' | 'already' | 'failed' }

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

/** Where ripple draws a button. A button in a place this ripple does not draw is left out. */
export type ButtonPlace = 'header' | 'add-field' | 'row-menu' | 'bulk-bar' | 'detail' | 'file' | 'player' | 'settings'

/** The sizes a popup page may ask for: small 480x360, medium 760x560, large 1100x800, capped to the viewport. */
export type PageSize = 'small' | 'medium' | 'large'

export type DetailTab = 'general' | 'files' | 'peers' | 'trackers'

/** A popup page opened directly when a button is pressed. */
export type ButtonPage = { id: string, size?: PageSize }

/**
 * A button ripple draws for a plugin. `label` is at most 40 characters, the button's tooltip and accessible name; a
 * button with an empty or longer one is left out. `icon` is an SVG `data:` url of at most 4 KB, drawn as a mask in
 * ripple's text colour, which `mirror` flips in a right to left language; with none, or another, the label's first
 * letter is drawn. Each plugin gets one button in each inline place and in `settings`, and three in `row-menu`.
 */
export type Button = {
  /** Handed back to `click`. Unique among the plugin's buttons. */
  id: string
  place: ButtonPlace
  label: string
  icon?: string
  mirror?: boolean
  /** Opens this popup page with the click's context instead of calling `click`. */
  page?: ButtonPage
}

/** What a click hands a plugin: the torrents, text, details tab, file index, or playback time it was pressed on. */
export type ClickContext = {
  infoHashes?: string[]
  infoHash?: string
  tab?: DetailTab
  text?: string
  file?: number
  time?: number
}

export type PageOpen = { id: string, size?: PageSize, context?: ClickContext }

export type PluginPeer = { address: string, client: string, down: number, up: number, progress: number }

export type PluginTracker = { origin: string, working: boolean }

export type PluginFolder = { name: string, allowed: boolean }

export type PluginLimits = { down: number, up: number }

export type PluginNetwork = {
  transport: 'relay' | 'direct'
  reachable: boolean
  inbound: number
  dhtNodes: number
  storageFull: boolean
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
  /** The popup page this connection is for and its context; null on the background connection. */
  page: { id: string, context: ClickContext } | null
  on: <E extends keyof PluginEvents>(event: E, listener: (value: PluginEvents[E]) => void) => Promise<() => void>
  ui: {
    /** Ripple asks `buttons` again, at most once a second. */
    buttonsChanged: () => Promise<void>
    /** Opens a popup page of this plugin inside Ripple's dialog. Only in the gesture window. */
    open: (page: PageOpen) => Promise<void>
    /** Closes this plugin's open popup page, if any. */
    close: () => Promise<void>
  }
  /** Strings this plugin keeps on this device, 256 KB in all, kept across its versions. `null` deletes one. */
  store: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string | null) => Promise<void>
  }
  /** Proposes a torrent through Ripple's add dialog, which names this plugin and asks the person. Needs no switch; only in the gesture window, at most 10 per window. */
  suggest: (source: Source) => Promise<AddResult>
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
  /** Removes a torrent from the library. With `deleteFiles`, deletes its bytes from browser storage too. */
  remove: (infoHash: string, options?: { deleteFiles?: boolean }) => Promise<void>
  /** Marks a torrent temporary so the storage budget may reclaim its bytes when room runs short. */
  makeTemporary: (infoHash: string) => Promise<void>
  /** Reads up to 4 MB from a file of a torrent (temporary ones too). Does not prioritize by default. */
  read: (infoHash: string, file: number, offset: number, length: number, options?: { prioritize?: boolean, signal?: AbortSignal }) => Promise<Uint8Array>
  /** Opens the torrent's file in Ripple's player. Needs `files` and the gesture window. */
  play: (infoHash: string, file: number) => Promise<void>
  /** Saves a file (or the whole torrent when `file` is omitted) through Ripple's service worker; answers false when none controls the page or it was cancelled. Needs `files` and the gesture window. */
  save: (infoHash: string, file?: number) => Promise<boolean>
  /** The chosen folder's name and whether write access is granted right now, or null when none is chosen. */
  folder: () => Promise<PluginFolder | null>
  /** Sets where a torrent's files belong; Ripple moves them once finished and the folder is granted. */
  move: (infoHash: string, location: 'browser' | 'folder') => Promise<void>
  peers: (infoHash: string) => Promise<PluginPeer[]>
  /** Each tracker's origin alone (never its passkey or message) and whether its last announce worked. */
  trackers: (infoHash: string) => Promise<PluginTracker[]>
  /** Bytes per second, 0 for unlimited. Omit a side to leave it alone. */
  setLimits: (infoHash: string, limits: { down?: number, up?: number }) => Promise<void>
  sessionLimits: () => Promise<PluginLimits>
  setSessionLimits: (limits: { down?: number, up?: number }) => Promise<void>
  network: () => Promise<PluginNetwork>
}

/** What a plugin hands ripple as its payload. */
export type RipplePlugin = {
  /** The switches it would like on. The person is asked about each one, and each starts off. */
  asks: Switch[]
  /**
   * Its buttons in `locale`, kept by ripple per plugin and language and asked again after `ui.buttonsChanged()`.
   * Answered within 5 s, or the buttons ripple kept stay.
   */
  buttons?: (locale: string) => Button[] | Promise<Button[]>
  /** A press of the button `id`. Answered within 10 s, or ripple says the plugin is not responding. */
  click?: (id: string, context: ClickContext) => void | Promise<void>
}
