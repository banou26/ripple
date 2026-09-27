// Builds the two things the swarm rig takes from fkn-client: @fkn/lib with the rig's broker baked in, and the web app that IS that broker
//   RIPPLE_RIG_FKN_CLIENT=/path/to/a/fkn-client/worktree node scripts/rig-prepare.mjs
//
// It writes lib/.env.local and web/.env.local and rebuilds lib/lib and web/build in place, which is
// why it refuses a main worktree: fkn/local's up.sh builds and serves those same paths for the rig
// on :1234, and pointing them at :5234 underneath it breaks every journey running there.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const topology = JSON.parse(readFileSync(new URL('../tests/swarm-rig/topology.json', import.meta.url), 'utf8'))

const fail = (message) => {
  console.error(`rig-prepare: ${message}`)
  process.exit(1)
}

const checkout = process.env.RIPPLE_RIG_FKN_CLIENT && resolve(process.env.RIPPLE_RIG_FKN_CLIENT)
if (!checkout) fail('set RIPPLE_RIG_FKN_CLIENT to an fkn-client worktree of its own (git -C <fkn-client> worktree add --detach <dir> origin/main)')
if (!existsSync(join(checkout, 'lib/package.json')) || !existsSync(join(checkout, 'web/package.json'))) {
  fail(`${checkout} is not an fkn-client checkout (no lib/ and web/ packages)`)
}

const git = (...args) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).stdout.trim()
if (resolve(checkout, git('rev-parse', '--git-dir')) === resolve(checkout, git('rev-parse', '--git-common-dir'))) {
  fail(`${checkout} is a main worktree. The rig rewrites its .env.local files and build output, so give it a worktree of its own:\n  git -C ${checkout} worktree add --detach <dir> origin/main`)
}

const run = (cwd, command, args, env = {}) => {
  console.log(`rig-prepare: ${command} ${args.join(' ')}  (in ${cwd.replace(checkout, '<fkn-client>')})`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`)
}

/** Every file under a directory whose text matches, for checking what a build actually baked. */
const filesMatching = (dir, pattern) => {
  const found = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(m?js|html)$/.test(name) && pattern.test(readFileSync(path, 'utf8'))) found.push(path)
    }
  }
  walk(dir)
  return found
}

const PRODUCTION_ORIGIN = /(?:https|wss):\/\/(?:[a-z0-9-]+\.)*fkn\.app/
const { broker, relay, closed } = topology
const relayOrigin = `https://${relay.host}:${relay.webtransport}/`
const certHashUrl = `http://${relay.host}:${relay.http}/cert-hash`
const dead = `localhost:${closed}`

if (!existsSync(join(checkout, 'node_modules'))) run(checkout, 'pnpm', ['install', '--frozen-lockfile'])
// the web app's workspace dependencies resolve through gitignored build output, and an unbuilt one fails at runtime rather than at build
run(checkout, 'pnpm', ['--filter', '@mfkn/web^...', 'run', 'build'])

// after the workspace build, which rebuilds lib in production mode with https://fkn.app baked in
const lib = join(checkout, 'lib')
writeFileSync(join(lib, '.env.local'), `# written by ripple scripts/rig-prepare.mjs\nVITE_WEB_ORIGIN=${broker.origin}\n`)
run(lib, 'npx', ['vp', 'build', '--mode', 'development'])
const libOut = join(lib, 'lib')
if (!existsSync(join(libOut, 'index.js'))) fail(`the lib built no ${libOut}/index.js`)
if (!filesMatching(libOut, new RegExp(broker.origin.replace(/[.:/]/g, '\\$&'))).length) fail(`the lib does not name ${broker.origin}`)
if (filesMatching(libOut, PRODUCTION_ORIGIN).length) fail('the lib still names a production origin')
if (filesMatching(libOut, /WEB_ORIGIN" environment variable/).length) fail('the lib built without VITE_WEB_ORIGIN')

const web = join(checkout, 'web')
writeFileSync(join(web, '.env.local'), [
  '# written by ripple scripts/rig-prepare.mjs: the swarm rig broker. Every origin is loopback, and the',
  `# ones the rig does not run point at ${dead}, which nothing listens on, so no request can reach production`,
  `VITE_WEB_ORIGIN=${broker.origin}`,
  `VITE_WEB_SANDBOX_ORIGIN=http://${dead}`,
  `VITE_WEB_PROXY_SANDBOX_ORIGIN=http://${dead}`,
  `VITE_API_ORIGIN=http://${dead}`,
  `VITE_WEBSOCKETS_ORIGIN=ws://${dead}/graphql`,
  `VITE_ROOMS_ORIGIN=ws://${dead}`,
  `VITE_PROXY_ORIGIN=http://${dead}/v0/`,
  `VITE_DEV_CONSOLE_ORIGIN=http://${dead}`,
  `VITE_DEV_API_ORIGIN=http://${dead}`,
  `VITE_WEBVPN_ORIGIN=${relayOrigin}`,
  `VITE_WEBVPN_CERT_HASH_URL=${certHashUrl}`,
  `VITE_WEBVPN_WS_ORIGIN=wss://${relay.host}:${relay.websocket}/`,
  '',
].join('\n'))
// NODE_ENV as well as the mode: `--mode development` alone leaves import.meta.env.DEV false, which
// drops the cert-hash pin (webtransport.ts) and the baked-relay-only dial (relays.ts) as dead code
run(web, 'npx', ['vp', 'build', '--mode', 'development'], { NODE_ENV: 'development' })
const webOut = join(web, 'build')
if (!existsSync(join(webOut, 'api.html'))) fail(`the web build has no ${webOut}/api.html`)
if (!filesMatching(webOut, new RegExp(certHashUrl.replace(/[.:/]/g, '\\$&'))).length) fail(`the broker does not pin ${certHashUrl}, so it was built without import.meta.env.DEV`)
if (filesMatching(webOut, PRODUCTION_ORIGIN).length) fail('the broker still names a production origin')

console.log(`rig-prepare: lib at ${libOut}, broker at ${webOut}, both baked for ${broker.origin}`)
