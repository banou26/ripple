/**
 * The swarm rig's fixture: a real, playable video that exists only on this machine, and its torrent.
 *
 * A video rather than random bytes because the rig times the first rendered FRAME, which needs
 * something the player can decode. Generated with ffmpeg on first use and cached by its parameters.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

type Bencodable = number | string | Buffer | Bencodable[] | { [key: string]: Bencodable | undefined }

const bencode = (value: Bencodable): Buffer => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`bencode: non-integer ${value}`)
    return Buffer.from(`i${value}e`)
  }
  if (typeof value === 'string') return bencode(Buffer.from(value, 'utf8'))
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  // libtorrent rejects an info dict whose keys are not sorted as raw bytes
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((key) => [bencode(key), bencode(value[key]!)]), Buffer.from('e')])
}

export type Fixture = {
  file: string
  dir: string
  name: string
  size: number
  sha256: string
  torrentFile: string
  infoHash: string
  pieceLength: number
  /** Whether the info dict carries `private`. Asserted false, see `makeTorrent`. */
  private: boolean
}

/**
 * A single-file, trackerless torrent with NO private flag.
 *
 * The flag would break a magnet-driven rig outright: libtorrent's ut_metadata plugin is never
 * attached to a private torrent that already has metadata (ut_metadata.cpp:631-637), which every
 * seeder handed a .torrent does, so no seeder serves metadata and the leecher parks at "Loading
 * metadata" forever with a healthy data plane. Isolation comes from the infohash instead: the
 * payload exists only here, so nobody else can serve it.
 */
const makeTorrent = (file: string, pieceLength: number) => {
  const size = statSync(file).size
  const hashes: Buffer[] = []
  const whole = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(pieceLength)
    for (let offset = 0; offset < size; offset += pieceLength) {
      const len = Math.min(pieceLength, size - offset)
      let got = 0
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, offset + got)
        if (n === 0) throw new Error(`unexpected EOF at ${offset + got} of ${size}`)
        got += n
      }
      hashes.push(createHash('sha1').update(buf.subarray(0, len)).digest())
      whole.update(buf.subarray(0, len))
    }
  } finally {
    closeSync(fd)
  }
  const info = { length: size, name: basename(file), 'piece length': pieceLength, pieces: Buffer.concat(hashes) }
  const infoBytes = bencode(info)
  return {
    // no announce and no announce-list: the swarm is exactly the peers the magnet names
    torrent: bencode({ info, 'creation date': 0 }),
    infoHash: createHash('sha1').update(infoBytes).digest('hex'),
    private: infoBytes.includes(Buffer.from('7:private')),
    size,
    sha256: whole.digest('hex'),
  }
}

const FFMPEG = process.env.RIG_FFMPEG ?? 'ffmpeg'

/**
 * Builds (or reuses) the fixture under `root`.
 *
 * `-movflags +faststart` puts the moov atom first, so playback can start from the head pieces
 * rather than waiting for the tail. `bitexact` and a fixed thread count keep the bytes, and so the
 * infohash, the same from one run to the next on one ffmpeg.
 */
export const ensureFixture = ({ root, seconds = 60, pieceLength = 512 * 1024 }: { root: string, seconds?: number, pieceLength?: number }): Fixture & { torrent: Buffer } => {
  const name = `ripple-rig-${seconds}s.mp4`
  const dir = join(root, 'payload')
  const file = join(dir, name)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(file) || statSync(file).size === 0) {
    const partial = `${file}.partial.mp4`
    rmSync(partial, { force: true })
    const result = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-pix_fmt', 'yuv420p', '-g', '60',
      '-threads', '4', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1',
      '-movflags', '+faststart', partial,
    ], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`ffmpeg could not build the fixture (${result.error?.message ?? result.stderr}); set RIG_FFMPEG or put ffmpeg on PATH`)
    }
    renameSync(partial, file)
  }
  const made = makeTorrent(file, pieceLength)
  const torrentFile = join(root, `${name}.torrent`)
  writeFileSync(torrentFile, made.torrent)
  return { file, dir, name, pieceLength, torrentFile, ...made }
}

/** A magnet naming the torrent and the exact peers to dial, which is how a trackerless swarm bootstraps. */
export const magnetFor = (fixture: Pick<Fixture, 'infoHash' | 'name'>, peers: { host: string, port: number }[]) =>
  [`magnet:?xt=urn:btih:${fixture.infoHash}`, `dn=${encodeURIComponent(fixture.name)}`, ...peers.map((peer) => `x.pe=${peer.host}:${peer.port}`)].join('&')
