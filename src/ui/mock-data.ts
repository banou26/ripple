import type { Torrent } from './types'

// Mock data for the Ripple UI. All names refer to original / public-domain
// works. Replaced by the libtorrent-wasm Session adapter once the integration
// lands (the field shapes are the contract).
export const MOCK_TORRENTS: Torrent[] = [
  {
    id: 't1',
    name: 'Open Source Linux Distribution — 24.04 LTS (amd64)',
    size: 4.6 * 1024, downloaded: 1.93 * 1024, progress: 0.42, state: 'downloading',
    down: 11.4 * 1024, up: 220, peers: { total: 84, utp: 51, tcp: 33 }, seeds: 142,
    eta: '3m 12s', ratio: 0.04, added: 'today, 14:02', tracker: 'open-tracker.example.org', flag: 'DE',
    files: [
      { name: 'linux-24.04-amd64.iso', size: 4500, progress: 0.42 },
      { name: 'SHA256SUMS', size: 0.3, progress: 1 },
      { name: 'README.txt', size: 0.05, progress: 1 },
    ],
    peerList: [
      { ip: '82.165.44.12', country: 'DE', proto: 'U', progress: 0.92, down: 1840, up: 0 },
      { ip: '104.21.77.108', country: 'US', proto: 'T', progress: 1.0, down: 2210, up: 0 },
      { ip: '203.0.113.7', country: 'JP', proto: 'U', progress: 0.78, down: 980, up: 12 },
      { ip: '78.46.91.4', country: 'FI', proto: 'U', progress: 1.0, down: 1620, up: 0 },
      { ip: '51.158.22.198', country: 'FR', proto: 'T', progress: 0.65, down: 730, up: 0 },
      { ip: '185.143.92.4', country: 'NL', proto: 'U', progress: 0.88, down: 1410, up: 0 },
      { ip: '200.55.41.220', country: 'BR', proto: 'T', progress: 0.34, down: 0, up: 140 },
      { ip: '61.218.99.10', country: 'TW', proto: 'U', progress: 0.95, down: 1230, up: 0 },
    ],
  },
  {
    id: 't2',
    name: 'Wikipedia English Snapshot — 2026-04 (text only)',
    size: 22.4 * 1024, downloaded: 19.5 * 1024, progress: 0.87, state: 'downloading',
    down: 4.2 * 1024, up: 510, peers: { total: 32, utp: 20, tcp: 12 }, seeds: 56,
    eta: '11m 04s', ratio: 0.02, added: 'yesterday', tracker: 'wikitorrents.example.net', flag: 'US',
  },
  {
    id: 't3',
    name: 'NASA Apollo Archive — High-Res Public Imagery, vol. 4',
    size: 12.1 * 1024, downloaded: 12.1 * 1024, progress: 1.0, state: 'seeding',
    down: 0, up: 1.8 * 1024, peers: { total: 14, utp: 11, tcp: 3 }, seeds: 0,
    eta: '—', ratio: 2.14, added: '3 days ago', tracker: 'archive-tracker.example.org', flag: 'US',
  },
  {
    id: 't4',
    name: 'Project Gutenberg — Public Domain Library Pack',
    size: 3.2 * 1024, downloaded: 3.2 * 1024, progress: 1.0, state: 'seeding',
    down: 0, up: 240, peers: { total: 6, utp: 4, tcp: 2 }, seeds: 0,
    eta: '—', ratio: 5.81, added: 'last week', tracker: 'gut-tracker.example.org', flag: 'GB',
  },
  {
    id: 't5',
    name: 'Free Music Archive — Creative Commons Sampler 2026',
    size: 1.8 * 1024, downloaded: 0.41 * 1024, progress: 0.23, state: 'paused',
    down: 0, up: 0, peers: { total: 0, utp: 0, tcp: 0 }, seeds: 28,
    eta: '—', ratio: 0, added: 'today, 12:48', tracker: 'fma-tracker.example.org', flag: 'US',
  },
  {
    id: 't6',
    name: 'Open Educational Resources — Mathematics Video Series',
    size: 8.4 * 1024, downloaded: 0, progress: 0, state: 'queued',
    down: 0, up: 0, peers: { total: 0, utp: 0, tcp: 0 }, seeds: 19,
    eta: 'queued', ratio: 0, added: 'today, 15:20', tracker: 'oer-tracker.example.org', flag: 'CA',
  },
  {
    id: 't7',
    name: 'Internet Archive — CC-licensed Documentary Collection',
    size: 6.7 * 1024, downloaded: 6.7 * 1024, progress: 1.0, state: 'done',
    down: 0, up: 0, peers: { total: 0, utp: 0, tcp: 0 }, seeds: 0,
    eta: '—', ratio: 1.42, added: '2 weeks ago', tracker: 'ia-tracker.example.org', flag: 'US',
  },
]
