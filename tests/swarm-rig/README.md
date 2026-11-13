# The swarm rig

`npm run test:e2e:rig` downloads a torrent that exists only on this machine. The seeders are
transmission daemons on `127.0.0.2` and up, the relay is a local webvpn build, and the broker is a
local fkn-client web build, so the only source of a byte is the fleet the magnet names. The public
swarm cannot give that: byte-identical code measured 14.7 s to 73.4 s to first frame there.

| piece | where | port |
| --- | --- | --- |
| broker (fkn-client `web`, development build) | `http://localhost:5234/api` | 5234 |
| relay (webvpn release build) | WebTransport, HTTP, WebSocket on `127.0.0.1` | 5433, 5434, 5443 |
| ripple (`build/`, served) | `http://localhost:5460` | 5460 |
| seeders (transmission 4) | `127.0.0.2:52600` and up, rpc `9400` and up | |

None of it overlaps fkn/local's rig (1234, 3000, 4433, 4560, 8443), so the two run side by side. The
ports live in [`topology.json`](./topology.json).

## Running it

It needs three checkouts, and an fkn-client worktree of its own, because the rig rewrites that
checkout's `.env.local` files and build output:

```sh
git -C ~/dev/horionsoftware/fkn-client worktree add --detach ~/dev/fkn-client-rig origin/main
(cd ~/dev/horionsoftware/webvpn && cargo build --release)

export RIPPLE_RIG_FKN_CLIENT=~/dev/fkn-client-rig
export RIPPLE_RIG_WEBVPN=~/dev/horionsoftware/webvpn
export RIPPLE_RIG_LOCAL=~/dev/horionsoftware/local
export RIPPLE_CHROME=$(command -v google-chrome-stable)
export RIG_TRANSMISSION=$(nix build --no-link --print-out-paths 'nixpkgs#transmission_4')

nix shell nixpkgs#xvfb-run -c env -u WAYLAND_DISPLAY -u NIXOS_OZONE_WL \
  xvfb-run -a -s "-screen 0 1280x720x24" npm run test:e2e:rig
```

It runs headful, because headless Chromium stalls the engine at a flat 0 B/s, and under Xvfb so no
window opens. `test:e2e:rig` runs three steps:

1. [`scripts/rig-prepare.mjs`](../../scripts/rig-prepare.mjs) builds `@fkn/lib` with
   `VITE_WEB_ORIGIN=http://localhost:5234` and the web app as the broker, then checks what each
   build baked in. It refuses a main worktree.
2. `npm run build`, which sees `RIPPLE_RIG_FKN_CLIENT` and resolves `@fkn/lib` to that local build
   (the published lib has `https://fkn.app` baked in, and no setting of ripple's can move it). The
   build warns when it does this. Afterwards `build/` points at the rig's broker, so rebuild without
   the variable before serving it for anything else.
3. [`playwright.rig.config.ts`](../../playwright.rig.config.ts) starts the relay (the environment
   `byo.sh webvpn --export` prints, moved to the rig's ports, with a fresh certificate and
   `FREE_RATE_BYTES_PER_SEC` at 1 GiB/s), the broker and ripple, then runs
   [`tests/swarm-rig.spec.ts`](../swarm-rig.spec.ts).

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
VPN readout goes to Reconnecting and back to On, and that OPFS ends up holding the fixture. It takes about 6
minutes, most of it libtorrent's own timeouts on the uTP connections the outage left behind. On engine 0.3.21 the
worker stops posting within 5 s of the drop and the spec fails. `RIPPLE_RIG_OUTAGE_MS`, `RIPPLE_RIG_SEEDER_KBPS`,
`RIPPLE_RIG_OUTAGE_AT` and `RIPPLE_RIG_RECOVERY_MS` move it, and `RIPPLE_RIG_RESULT` names a file for the
per-second record.

## Knobs

`RIPPLE_RIG_SEEDERS` (default 4), `RIPPLE_RIG_BUDGET_MS` (swarm arm, 120000),
`RIPPLE_RIG_CONTROL_MS` (30000), `RIPPLE_RIG_STATE` (fixture and seeder state, default
`$TMPDIR/ripple-swarm-rig`). The config refuses to start when `WAYLAND_DISPLAY` or `NIXOS_OZONE_WL`
is set, because the Nix Chrome wrapper then opens a real window even under `xvfb-run`.
