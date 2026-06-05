// Shared types for the Ripple client UI (ported from the design bundle).
// The torrent shape is currently mock-data-driven; it's the contract the
// libtorrent-wasm Session adapter will fill in once the integration lands.

export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error'

export type TorrentPeers = { total: number, utp: number, tcp: number }
export type TorrentFile = { name: string, size: number, progress: number }
export type TorrentPeer = { ip: string, country: string, proto: 'U' | 'T', progress: number, down: number, up: number }

export type Torrent = {
  id: string
  name: string
  size: number          // MB
  downloaded: number    // MB
  progress: number      // 0..1
  state: TorrentState
  down: number          // KB/s
  up: number            // KB/s
  peers: TorrentPeers
  seeds: number
  eta: string
  ratio: number
  added: string
  tracker: string
  flag: string
  files?: TorrentFile[]
  peerList?: TorrentPeer[]
}

export type Theme = 'light' | 'dark'
export type Accent = 'water' | 'ember' | 'moss' | 'violet'
export type Density = 'compact' | 'regular' | 'comfy'
export type Layout = 'hero' | 'list'

export type Tweaks = {
  theme: Theme
  accent: Accent
  density: Density
  layout: Layout
  showAdv: boolean
  utp: boolean
  tcp: boolean
}
