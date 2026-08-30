/*
 * Stamp the service worker with the build it belongs to, and the list of chunks it may cache.
 *
 * Runs at the END of `copy-html`, which is the last step of `build`, so `build/` is complete and
 * every hashed filename is known. Not a vite plugin: `copy-html` runs after `vp build` and would
 * overwrite whatever a plugin emitted.
 *
 * WHY A CONTENT HASH AND NOT THE COMMIT SHA. The build id has to change exactly when the bytes
 * change, in both directions, or the update flow lies. `__COMMIT_HASH__` fails both halves: a
 * comment-only commit produces a byte-identical build under a new sha, which would announce an
 * update that changes nothing, and vite.config.ts falls back to the literal 'main' when git is
 * unavailable, which would freeze the id for every build after that. So the id is a hash of the
 * built output, which is the thing the update is actually about.
 *
 * Every assertion below exits non-zero with its reason. A stamp that silently no-ops would ship a
 * worker that never changes, on a feature whose whole job is noticing that something changed.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const BUILD_DIR = 'build'
const SOURCE = 'src/sw.js'
const OUT = join(BUILD_DIR, 'sw.js')
const MODE_FILE = 'src/sw.mode'

/** The same rule the worker itself routes on. Kept in step by the test that imports both. */
export const HASHED = /^\/(?:assets\/)?[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8,}\.js$/

const MAX_CACHE_BYTES = 8 * 1024 * 1024

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * Replace three whole marker lines. Exported so the test can stamp a worker and boot the RESULT,
 * rather than only asserting that a placeholder exists in the source.
 */
export const stamp = (source, { mode, build, manifest }) => {
  const marks = [
    [/^const MODE = .*\/\/ @stamp:mode$/m, `const MODE = ${JSON.stringify(mode)}    // @stamp:mode`],
    [/^const BUILD = .*\/\/ @stamp:build$/m, `const BUILD = ${JSON.stringify(build)}   // @stamp:build`],
    [/^const MANIFEST = .*\/\/ @stamp:manifest$/m, `const MANIFEST = ${JSON.stringify(manifest)} // @stamp:manifest`],
  ]
  let out = source
  for (const [re, replacement] of marks) {
    const before = out
    out = out.replace(re, replacement)
    if (out === before) throw new Error(`marker not found or matched nothing: ${re}`)
  }
  return out
}

const die = (why) => { console.error(`[build-sw] ${why}`); process.exit(1) }

// A dashboard variable is invisible in a diff and stays set across the next ten deploys, which would
// silently disable the streamed download path for everyone. The lever lives in git.
if (process.env.CF_PAGES && process.env.RIPPLE_SW_MODE) {
  die('RIPPLE_SW_MODE is set in a Pages build. The kill switch is src/sw.mode, committed, not an environment variable.')
}

const mode = (process.env.RIPPLE_SW_MODE ?? readFileSync(MODE_FILE, 'utf8')).trim()
if (mode !== 'cache' && mode !== 'purge') die(`src/sw.mode must be "cache" or "purge", found ${JSON.stringify(mode)}`)

const files = walk(BUILD_DIR)
  .map((f) => relative(BUILD_DIR, f).split('\\').join('/'))
  .filter((f) => f !== 'sw.js' && f !== '_headers')
  .sort()

const hashes = new Map(files.map((f) => [f, sha(readFileSync(join(BUILD_DIR, f)))]))
const build = sha(files.map((f) => `${f}:${hashes.get(f)}`).join('\n')).slice(0, 16)

const manifest = files
  .filter((f) => HASHED.test('/' + f))
  .map((f) => ['/' + f, hashes.get(f).slice(0, 16)])

const total = manifest.reduce((n, [f]) => n + statSync(join(BUILD_DIR, f.slice(1))).size, 0)

if (manifest.length < 3) die(`only ${manifest.length} hashed chunks matched; the manifest would fix nothing`)
const workers = manifest.filter(([f]) => /\/assets\/worker-[^/]+\.js$/.test(f))
if (workers.length !== 1) die(`expected exactly one engine worker chunk, found ${workers.length}: ${workers.map(([f]) => f).join(', ')}`)
// manifest and entry point must come from the same build, or the cache names a chunk nothing loads
const entry = readFileSync(join(BUILD_DIR, 'index.js'), 'utf8')
if (!entry.includes(workers[0][0].slice(1))) die(`build/index.js does not reference ${workers[0][0]}; manifest and entry are from different builds`)
if (total > MAX_CACHE_BYTES) die(`manifest is ${(total / 1e6).toFixed(1)} MB, over the ${MAX_CACHE_BYTES / 1e6} MB ceiling`)

let out
try {
  out = stamp(readFileSync(SOURCE, 'utf8'), { mode, build, manifest })
} catch (e) { die(String(e.message)) }

if (out.includes("= 'dev'")) die('a dev placeholder survived the stamp; the worker would never change between builds')

writeFileSync(OUT, out)
console.log(`[build-sw] stamp: build=${build} mode=${mode} manifest=${manifest.length} bytes=${total}`)
