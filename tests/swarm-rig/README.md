# The swarm rig

`npm run test:e2e:rig` downloads a torrent that exists only on this machine. The seeders are
transmission daemons on `127.0.0.2` and up, the relay is a local webvpn build, the broker is a
local fkn-client web build and the proxy a local build too, so the only source of a byte is the
fleet the magnet names and the WebRTC peers the lane's own tracker introduces. The public swarm
cannot give that: byte-identical code measured 14.7 s to 73.4 s to first frame there.

| piece | where | port |
| --- | --- | --- |
| broker (fkn-client `web`, development build) | `http://localhost:5234/api` | 5234 |
| relay (webvpn release build) | WebTransport, HTTP, WebSocket on `127.0.0.1` | 5433, 5434, 5443 |
| proxy (proxy release build) | `http://localhost:5470/v0`, metrics on 5471 | 5470, 5471 |
| tracker ([`names.mjs`](./names.mjs)) | `ws://ripple-tracker.test:5472`, which is `192.0.2.1` | 5472 |
| name resolver (`names.mjs`), and what it and the tracker saw | `http://127.0.0.1:5473/dns-query`, `/seen` | 5473 |
| ripple (`build/`, served) | `http://localhost:5460` | 5460 |
| seeders (transmission 4) | `127.0.0.2:52600` and up, rpc `9400` and up | |

None of it overlaps fkn/local's rig (1234, 3000, 4433, 4560, 8443), so the two run side by side. The
ports live in [`topology.json`](./topology.json).

## A network of its own

The lane runs inside [`netns.sh`](./netns.sh), and the config refuses to start outside it. It makes a
network namespace with loopback and one interface that leads nowhere (`192.0.2.1`, the default
route), hides the machine's name services and answers one name, the tracker's. So nothing the lane
starts reaches another machine: not the browser, not the engine's DHT, not the seeders. It is also
what the proxy needs, which listens on every address and looks names up with the machine's resolver.

The relay asks the lane's resolver for names (`WEBVPN_DNS_UPSTREAM`), which knows the tracker and
answers that nothing else exists. Ripple's build for the lane names that tracker in place of the two
public ones, asks no STUN host and takes peers on private addresses (`RIG_TRACKER` in
`src/torrent/vpn-config.ts`), since every peer here is this machine. `192.0.2.1` stands for the
relay's public address: the relay's connection to the tracker leaves from it, so it is what a peer
behind the relay says it is reached at.

## Running it

It needs four checkouts, and an fkn-client worktree of its own, because the rig rewrites that
checkout's `.env.local` files and build output. The relay has to be 0.5.3 or later (it looks names
up) and the proxy one that reads a WebSocket's target from a subprotocol entry, both on their
`main` since 2026-11-13:

```sh
git -C ~/dev/horionsoftware/fkn-client worktree add --detach ~/dev/fkn-client-rig origin/main
(cd ~/dev/horionsoftware/webvpn && cargo build --release)
(cd ~/dev/horionsoftware/proxy && nix-shell --run 'cargo build --release')

export RIPPLE_RIG_FKN_CLIENT=~/dev/fkn-client-rig
export RIPPLE_RIG_WEBVPN=~/dev/horionsoftware/webvpn
export RIPPLE_RIG_PROXY=~/dev/horionsoftware/proxy
export RIPPLE_RIG_LOCAL=~/dev/horionsoftware/local
export RIPPLE_CHROME=$(command -v google-chrome-stable)
export RIG_TRANSMISSION=$(nix build --no-link --print-out-paths 'nixpkgs#transmission_4')

nix shell nixpkgs#xvfb-run -c env -u WAYLAND_DISPLAY -u NIXOS_OZONE_WL \
  tests/swarm-rig/netns.sh xvfb-run -a -s "-screen 0 1280x720x24" npm run test:e2e:rig
```

It runs headful, because headless Chromium stalls the engine at a flat 0 B/s, and under Xvfb so no
window opens. `test:e2e:rig` runs three steps:

1. [`scripts/rig-prepare.mjs`](../../scripts/rig-prepare.mjs) builds `@fkn/lib` with
   `VITE_WEB_ORIGIN=http://localhost:5234` and the web app as the broker, with the rig's relay and
   proxy as its only ones, then checks what each build baked in. It refuses a main worktree.
2. `npm run build`, which sees `RIPPLE_RIG_FKN_CLIENT` and resolves `@fkn/lib` to that local build
   (the published lib has `https://fkn.app` baked in, and no setting of ripple's can move it), and
   bakes the rig's tracker in. The build warns when it does this. Afterwards `build/` points at the
   rig's broker and tracker, so rebuild without the variable before serving it for anything else.
3. [`playwright.rig.config.ts`](../../playwright.rig.config.ts) starts the relay (the environment
   `byo.sh webvpn --export` prints, moved to the rig's ports, with a fresh certificate,
   `FREE_RATE_BYTES_PER_SEC` at 1 GiB/s and the rig's resolver), the proxy, the tracker and the
   resolver, the broker and ripple, then runs each spec in a run of its own. What the relay and the
   proxy wrote is kept under `logs/` in `RIPPLE_RIG_STATE`.

## What it checks

The spec has three tests, run in order:

- **Configuration.** The relay answers. The RUNNING relay's environment allows private targets and
  carries the raised rate. `/api` serves the broker's own document, not the SPA fallback.
- **The swarm arm.** It makes a 60 s 720p fixture with ffmpeg (no private flag, which would stop
  seeders serving metadata to a magnet). It starts N seeders with staggered adds and opens `/watch`
  for the magnet in a fresh regular profile. It then asserts that the engine held the whole file,
  that OPFS holds it piece for piece and by SHA-256, that a frame was painted, and that the seeders
  uploaded at least the file. It prints time to first byte, first frame and completion from the add.
- **The control.** The same fleet comes up and goes down, and the same visit runs for 30 s. It must
  see 0 bytes in the engine and in OPFS, and the swarm arm's own assertion must FAIL on it.

The seeders run under a shell that kills them when the test process is gone, so a run killed
outright leaves nothing on their addresses. Without that shell, all four outlived a SIGKILL.

The engine's DHT is on, and it announces the infohash through the relay. So the control can see a
stray peer (1 peer in two of three runs, 0 bytes each time). This is why the seeders' own upload
count is part of the claim.

## The relay drop

`npm run e2e:rig` then runs [`tests/swarm-rig-relay-drop.spec.ts`](../swarm-rig-relay-drop.spec.ts) in a run of its
own, since it stops the relay the config started: the seeders capped at 100 kB/s each,
the relay stopped with SIGTERM once 20% of the fixture is in, and started again 20 s later from the same binary,
environment and certificate. It asserts that the engine worker never goes 5 s without a state message, that the
VPN readout goes to Reconnecting and back to On, that bytes move again within 20 s of the relay's return (5.8 to
8.9 s measured), that both sockets are back on the port the session reserved, that the player carries on with no
"playback failed", and that OPFS ends up holding the fixture. It takes about 2.5 minutes. Engine 0.3.21 fails it on
the worker going silent within 5 s of the drop; 0.3.22 fails it on the resume, its bytes coming back 236 to 245 s
after the relay. `RIPPLE_RIG_OUTAGE_MS`, `RIPPLE_RIG_SEEDER_KBPS`, `RIPPLE_RIG_OUTAGE_AT`,
`RIPPLE_RIG_RECOVERY_MS` (150 s) and `RIPPLE_RIG_RESUME_MS` (20 s) move it, and `RIPPLE_RIG_RESULT` names a file
for the per-second record.

## Knobs

`RIPPLE_RIG_SEEDERS` (default 4), `RIPPLE_RIG_BUDGET_MS` (swarm arm, 120000),
`RIPPLE_RIG_CONTROL_MS` (30000), `RIPPLE_RIG_STATE` (fixture and seeder state, default
`$TMPDIR/ripple-swarm-rig`). The config refuses to start when `WAYLAND_DISPLAY` or `NIXOS_OZONE_WL`
is set, because the Nix Chrome wrapper then opens a real window even under `xvfb-run`.
