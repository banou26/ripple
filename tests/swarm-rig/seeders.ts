/**
 * A fleet of real transmission daemons seeding the fixture on loopback, one address each.
 *
 * Ported from libtorrent-wasm's node rig (tests/rig/seeders.mjs), whose traps it inherits:
 * libtorrent dedups peers by address, so every seeder gets its own 127.0.0.x or the fleet is one
 * peer; the torrent ADDS are staggered across one rechoke period, because transmission anchors its
 * 10 s rechoke at the add and a tight loop phase-locks every seeder into unchoking at one instant;
 * and it refuses an occupied address, because a leaked daemon answers every readiness check while
 * serving some other torrent.
 */
import type { ChildProcess } from 'node:child_process'

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

const daemonBin = () => {
  const root = process.env.RIG_TRANSMISSION
  const daemon = root ? join(root, 'bin/transmission-daemon') : 'transmission-daemon'
  if (spawnSync(daemon, ['--version']).error) {
    throw new Error("transmission not found: set RIG_TRANSMISSION=$(nix build --no-link --print-out-paths 'nixpkgs#transmission_4')")
  }
  return daemon
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const answers = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const socket = net.connect({ host, port })
  const done = (value: boolean) => { socket.destroy(); resolve(value) }
  socket.on('connect', () => done(true))
  socket.on('error', () => done(false))
  setTimeout(() => done(false), 500)
})

/**
 * Every daemon this process started, as process groups, killed whichever way the run ends.
 *
 * node does not kill its children when it exits, and a leaked seeder squats its address for the
 * next run. `exit` covers a normal end, `stop()` a test's own, and the shell wrapper below the one
 * nothing in node can see: the worker being killed outright.
 */
const live = new Set<ChildProcess>()
const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  try { if (child.pid) process.kill(-child.pid, signal) } catch {}
}
process.on('exit', () => { for (const child of live) killGroup(child, 'SIGKILL') })

/**
 * Runs the daemon under a shell that kills it the moment `owner` is gone.
 *
 * `exec` would lose the watchdog, so the daemon runs as the shell's child and the shell polls both.
 */
const WATCHDOG = [
  'owner=$1; shift',
  '"$@" & d=$!',
  'while kill -0 "$owner" 2>/dev/null && kill -0 "$d" 2>/dev/null; do sleep 0.5; done',
  'kill -9 "$d" 2>/dev/null; wait "$d"',
].join('\n')

export type Peer = { host: string, port: number }

export type FleetOptions = {
  dir: string
  dataDir: string
  torrentFile: string
  count: number
  firstHost: number
  basePeerPort: number
  baseRpcPort: number
  rechokeMs?: number
}

export class SeederFleet {
  readonly peers: Peer[] = []
  private procs: { child: ChildProcess, rpc: number, log: string }[] = []
  private readonly daemon = daemonBin()
  private sessions = new Map<number, string>()

  constructor (private readonly options: FleetOptions) {
    const { count, firstHost, basePeerPort } = options
    for (let i = 0; i < count; i++) this.peers.push({ host: `127.0.0.${firstHost + i}`, port: basePeerPort + i })
  }

  /** Transmission's RPC, which answers 409 with the session id to use until one is sent. */
  private async rpc<T> (port: number, method: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/transmission/rpc`, {
        method: 'POST',
        headers: { 'x-transmission-session-id': this.sessions.get(port) ?? '' },
        body: JSON.stringify({ method, arguments: args }),
      })
      if (response.status === 409) {
        this.sessions.set(port, response.headers.get('x-transmission-session-id') ?? '')
        continue
      }
      const body = await response.json() as { result: string, arguments: T }
      if (body.result !== 'success') throw new Error(`transmission ${method} on ${port}: ${body.result}`)
      return body.arguments
    }
    throw new Error(`transmission ${method} on ${port}: no session id`)
  }

  private torrents (port: number) {
    return this.rpc<{ torrents: { percentDone: number, status: number, uploadedEver: number }[] }>(
      port, 'torrent-get', { fields: ['percentDone', 'status', 'uploadedEver'] },
    ).then(({ torrents }) => torrents)
  }

  async start () {
    const { dir, dataDir, torrentFile, baseRpcPort, rechokeMs = 10_000 } = this.options
    const occupied: string[] = []
    for (const [i, peer] of this.peers.entries()) {
      if (await answers(peer.host, peer.port)) occupied.push(`${peer.host}:${peer.port}`)
      if (await answers('127.0.0.1', baseRpcPort + i)) occupied.push(`127.0.0.1:${baseRpcPort + i} (rpc)`)
    }
    if (occupied.length) {
      throw new Error(`seeder addresses already in use: ${occupied.join(', ')}. A leaked seeder makes every number describe the wrong torrent; clear it with pkill -f "transmission-daem[o]n" (the character class keeps pkill from matching itself)`)
    }

    for (const [i, peer] of this.peers.entries()) {
      const rpc = baseRpcPort + i
      const config = join(dir, `seeder-${i}`)
      mkdirSync(config, { recursive: true })
      // transmission 4 reads snake_case keys and silently ignores the 3.x hyphenated ones
      writeFileSync(join(config, 'settings.json'), JSON.stringify({
        bind_address_ipv4: peer.host,
        peer_port: peer.port,
        peer_port_random_on_start: false,
        rpc_bind_address: '127.0.0.1',
        rpc_port: rpc,
        rpc_authentication_required: false,
        rpc_whitelist_enabled: false,
        rpc_host_whitelist_enabled: false,
        download_dir: dataDir,
        incomplete_dir_enabled: false,
        // the swarm is exactly the peers the magnet names; any discovery left on can pull a real one in
        dht_enabled: false,
        pex_enabled: false,
        lpd_enabled: false,
        port_forwarding_enabled: false,
        encryption: 'tolerated',
        speed_limit_up_enabled: false,
        ratio_limit_enabled: false,
        idle_seeding_limit_enabled: false,
        seed_queue_enabled: false,
        message_level: 1,
      }, null, 2))
      const log = join(config, 'daemon.log')
      const child = spawn('sh', ['-c', WATCHDOG, 'seeder', String(process.pid), this.daemon,
        '-f', '-g', config, '-i', peer.host, '-P', String(peer.port), '-p', String(rpc), '-w', dataDir,
        '-T', '-O', '-Y', '-M', '-B', '--log-level', 'error', '-e', log,
      ], { stdio: 'ignore', detached: true })
      live.add(child)
      child.on('close', () => live.delete(child))
      this.procs.push({ child, rpc, log })
    }

    for (const { rpc, log } of this.procs) {
      const deadline = Date.now() + 20_000
      while (!await answers('127.0.0.1', rpc)) {
        if (Date.now() > deadline) throw new Error(`seeder rpc ${rpc} never came up, see ${log}`)
        await sleep(100)
      }
    }

    const metainfo = readFileSync(torrentFile).toString('base64')
    for (const [i, { rpc }] of this.procs.entries()) {
      // download-dir is where the payload already sits, so transmission verifies it and seeds
      await this.rpc(rpc, 'torrent-add', { metainfo, 'download-dir': dataDir })
      if (i < this.procs.length - 1) await sleep(Math.round(rechokeMs / this.procs.length))
    }
    return this.peers
  }

  /** Complete and not queued for or in a check (status 1 and 2). An idle complete torrent is never "seeding". */
  async waitSeeding (timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const states = await Promise.all(this.procs.map(({ rpc }) => this.torrents(rpc)))
      if (states.every(([torrent]) => torrent && torrent.percentDone === 1 && torrent.status !== 1 && torrent.status !== 2)) return
      await sleep(250)
    }
    throw new Error('the seeders never finished verifying the payload')
  }

  /** Payload bytes each seeder has uploaded, the swarm's own account of who served a run. */
  async uploaded (): Promise<number[]> {
    return Promise.all(this.procs.map(async ({ rpc }) => (await this.torrents(rpc))[0]?.uploadedEver ?? 0))
  }

  async stop () {
    const procs = this.procs
    this.procs = []
    // the whole group, so the daemon goes with its watchdog rather than being orphaned by it
    for (const { child } of procs) killGroup(child, 'SIGTERM')
    // the addresses are the proof: a stopped fleet leaves nothing answering on them
    const stillUp = async () => (await Promise.all(this.peers.map((peer) => answers(peer.host, peer.port)))).some(Boolean)
    const deadline = Date.now() + 5_000
    while (await stillUp() && Date.now() < deadline) await sleep(100)
    if (await stillUp()) {
      for (const { child } of procs) killGroup(child, 'SIGKILL')
      await sleep(500)
      if (await stillUp()) throw new Error('a seeder still answers after stop(), even after SIGKILL')
    }
  }
}
