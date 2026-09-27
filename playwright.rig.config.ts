import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * The swarm rig: ripple built against a local broker, over a local relay, downloading from local
 * seeders. Nothing it starts is fkn/local's rig and no port overlaps it (1234, 3000, 4433, 4560,
 * 8443 stay free), so the two can run side by side. `npm run test:e2e:rig`; see the README.
 *
 * Needs three checkouts, named by env:
 *  - RIPPLE_RIG_FKN_CLIENT  an fkn-client worktree of its own, built by scripts/rig-prepare.mjs
 *  - RIPPLE_RIG_WEBVPN      the relay checkout, after `cargo build --release`
 *  - RIPPLE_RIG_LOCAL       fkn/local, whose byo.sh is the relay's environment
 */
const topology = JSON.parse(readFileSync(new URL('./tests/swarm-rig/topology.json', import.meta.url), 'utf8'))

const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`the swarm rig needs ${name}; see playwright.rig.config.ts`)
  return resolve(value)
}

const fknClient = required('RIPPLE_RIG_FKN_CLIENT')
const local = required('RIPPLE_RIG_LOCAL')
const relayBin = join(required('RIPPLE_RIG_WEBVPN'), 'target/release/webvpn')
if (!existsSync(relayBin)) throw new Error(`no relay at ${relayBin}: run cargo build --release in RIPPLE_RIG_WEBVPN`)
if (!existsSync(join(fknClient, 'web/build/api.html'))) throw new Error(`no broker build in ${fknClient}: run node scripts/rig-prepare.mjs`)

/**
 * A transfer only moves headful, and headful must never mean a window on the owner's desktop.
 *
 * The Nix Chrome wrapper appends --ozone-platform-hint=auto whenever WAYLAND_DISPLAY and
 * NIXOS_OZONE_WL are both set, which puts the browser on the real compositor even under xvfb-run.
 * Refusing here is cheaper than finding out from a window.
 */
if (process.env.WAYLAND_DISPLAY || process.env.NIXOS_OZONE_WL || !process.env.DISPLAY) {
  throw new Error('the swarm rig runs headful under Xvfb only: env -u WAYLAND_DISPLAY -u NIXOS_OZONE_WL xvfb-run -a -s "-screen 0 1280x720x24" npm run test:e2e:rig')
}

// the spec derives the same directory for its fixture and seeders
const RIG_STATE = process.env.RIPPLE_RIG_STATE ?? join(tmpdir(), 'ripple-swarm-rig')

const { relay, broker, app } = topology

/**
 * The relay as `byo.sh` describes it, moved onto the rig's own ports and a fresh certificate.
 *
 * Fresh because the relay prefers any PEM on disk and never checks its expiry, and WebTransport
 * refuses a pinned certificate valid for more than 14 days, so a stale pair fails as a pinning
 * error. It runs from the certificate directory because the relay reads `.env` from its cwd and
 * the webvpn checkout carries one. The `[ = false ]` fails the start if byo.sh ever stops allowing
 * private targets, since every seeder is on 127.0.0.x.
 */
const relayCommand = [
  'set -e',
  'eval "$("$RIG_LOCAL/byo.sh" webvpn --export)"',
  '[ "$WEBVPN_BLOCK_PRIVATE_TARGETS" = false ]',
  'export ADDRESS="$RIG_RELAY_HOST" WEBSOCKET_ADDRESS="$RIG_RELAY_HOST"',
  'export WEBTRANSPORT_PORT="$RIG_WT" HTTP_PORT="$RIG_HTTP" WEBSOCKET_PORT="$RIG_WS"',
  'export CERT_FOLDER_PATH="$RIG_CERTS" FREE_RATE_BYTES_PER_SEC="$RIG_FREE_RATE"',
  'rm -rf "$CERT_FOLDER_PATH" && mkdir -p "$CERT_FOLDER_PATH" && cd "$CERT_FOLDER_PATH"',
  'exec "$RIG_RELAY_BIN"',
].join('; ')

export default defineConfig({
  testDir: './tests',
  testMatch: '**/swarm-rig.spec.ts',
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  outputDir: 'test-results/swarm-rig',
  use: { baseURL: app.origin },
  webServer: [
    {
      command: `bash -c '${relayCommand}'`,
      url: `http://${relay.host}:${relay.http}/health`,
      env: {
        ...process.env as Record<string, string>,
        RIG_LOCAL: local,
        RIG_RELAY_BIN: relayBin,
        RIG_RELAY_HOST: relay.host,
        RIG_WT: String(relay.webtransport),
        RIG_HTTP: String(relay.http),
        RIG_WS: String(relay.websocket),
        RIG_CERTS: join(RIG_STATE, 'relay-certs'),
        RIG_FREE_RATE: String(topology.freeRateBytesPerSec),
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // no -s: the broker is /api, which clean URLs map to api.html, where the SPA fallback would answer index.html
      command: `npx serve -C -p ${broker.port} ${join(fknClient, 'web/build')}`,
      url: `${broker.origin}/api`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx serve -s -C -p ${app.port} build`,
      url: app.origin,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'rig',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        launchOptions: {
          args: ['--ozone-platform=x11', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--enable-experimental-web-platform-features'],
          executablePath: process.env.RIPPLE_CHROME || undefined,
        },
      },
    },
  ],
})
