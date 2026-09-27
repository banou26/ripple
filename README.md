# Ripple, the torrent app that respect your privacy

THE app that allows you to download torrents and stream video files from the safety of your browser!

## Embedding

`/watch` and `/download` are the pages another site puts in an iframe. Both take a magnet and the
same query; the path chooses which one renders. `/watch` plays the file, `/download` delivers it.

| param | value | meaning |
| --- | --- | --- |
| `m` | the packed magnet, base64url | what Ripple writes today |
| `magnet` | base64 of the magnet URI | the original form, read forever |
| `fileIndex` | a file index | the file `/watch` plays; the fallback `/download` uses |
| `files` | `all`, `3`, `0-4`, `0,2,5` | what `/download` delivers |
| `f` | a packed file list | optional preview, `/download` only |

One of `m` or `magnet` is required. `m` wins if both are present.

There is no `mode` parameter. It used to choose the page and is now neither written nor read, so a
link still carrying one gets the page its PATH names and the parameter is ignored.

### The two magnet forms

`magnet=<base64 of the magnet URI>` is the original, and it is **permanent**. Every link ever handed
out with it keeps working, and an embedder that finds it easier to write can keep writing it. Nothing
about it has changed.

`m=` is the same torrent packed smaller: the infohash as raw bytes rather than 40 hex characters, and
the rest of the query deflated against a fixed table of the announce URLs that public magnets
overwhelmingly share. It is base64url, so a query string carries it without escaping anything. Across
a corpus covering every magnet form Ripple accepts, the median link is **69% shorter**; a five-tracker
release goes from a 549-character URL to 148. A magnet using only private trackers has nothing to
match against and still comes out around 42% shorter, on the strength of the packed infohash alone.

Ripple writes whichever of the two is shorter, which is almost always `m`. The digit is a version:
the table it compresses against can never be edited, so if it ever needs to change the parameter
becomes `m2` and `m` keeps decoding the way it always did.

### Parameter order

Order never matters when READING a link. When writing one, Ripple puts the plainest parts first:

```
/watch?fileIndex=3&m=AQAIraWnphg6rh4J2DHfZ0jVZglaEAMWq8GZeSWpORSmTXxFBwA
/download?files=2&m=AQAIraWnphg6rh4J2DHfZ0jVZglaEAMWq8GZeSWpORSmTXxFBwA
/download?m=AQAIraWnphg6rh4J2DHfZ0jVZglaEAMWq8GZeSWpORSmTXxFBwA&f=AWNSC87MK0nN0YdQ
```

The path, then which files, then the packed torrent, then `f`. The torrent used to lead, from when
it was the only thing in the link; now that everything around it is base64url or an index, leading
with it buried the one part a person can read behind forty characters of noise. A URL is read from
the left and truncated from the right, so `f`, the longest parameter and the one a reader cares
least about, goes last.

### `f`, the file list

A magnet names a torrent and nothing else, so a download link normally opens on "Reading the torrent
from the network" for as long as metadata takes. `f` closes that gap by carrying the file list the
sender already had, and the page shows it immediately, marked **from the link**.

It is a preview and Ripple treats it as one. It never decides what gets downloaded: the button stays
disabled until real metadata arrives, the download itself is resolved against that metadata, and the
per-file buttons are not rendered at all while the list is only the link's claim. A link that
describes a torrent inaccurately therefore costs a reader a wrong line on screen for a few seconds,
and can never cost them the wrong file on disk.

Ripple writes it only on `/download`, only when it has the list, and only when it fits: a
12-episode season costs about 172 characters and a 48-file season about 416. Past a budget it is
left off entirely rather than pushing the link past what a chat message will carry. Absent, `f`
changes nothing, so a link without it behaves exactly as it always has.

Putting the whole `.torrent` in the URL instead does not work, and the reason is arithmetic rather
than encoding: piece hashes are around 94% of a torrent and are 20 bytes of SHA1 per piece, so they
are incompressible. A 12-episode season is a 28,512-character URL and a 40 GB remux is 68,676. The
file list is the part that is both small and worth having.

### `/watch`

Plays `fileIndex` (0 if absent) in the media player, with the filename, peer count and transfer
rates drawn over the video.

The mode used to be a parameter, and for a while Ripple wrote `mode=watch` out in full so that a
link said what it did rather than being told apart by an absence. The path says it for free and in
the part of a URL that is read first, so the parameter is gone from both halves and a link still
carrying one gets the page its path names.

**This route was `/embed` until 2026-09-09 and the old path is gone rather than redirected.** A link
written against it 404s to the SPA shell; rewrite it as `/watch` with the query untouched.

### `/download`

A download page: the release name, the size of the selection, and one button. One file is delivered
as that file; anything more is delivered as a single `.zip`, written straight through to the
browser's own downloader without ever being held in memory.

```
/download?magnet=<base64>                 the whole torrent, as a zip
/download?magnet=<base64>&files=3         just file 3
/download?magnet=<base64>&files=0-4       files 0 to 4 inclusive, as a zip
/download?magnet=<base64>&files=0,2,5     those three, as a zip
/download?magnet=<base64>&fileIndex=3     same as files=3, so a watch URL becomes a download by
                                          swapping /watch for /download and nothing else
```

`files` outranks `fileIndex`. Indices the torrent does not have are dropped rather than clamped, and
a selection that resolves to nothing says so instead of quietly downloading the whole torrent.

### What an embedder has to grant

**The frame needs `allow-downloads` if it is sandboxed at all.** Sandbox flags on a nested browsing
context are the union of the parent's set and the child's, so a flag the embedder withheld cannot be
restored from inside, and Chrome then refuses the download *silently*: the navigation is dropped, no
event fires and nothing throws. There is no `downloads` feature in Permissions-Policy, so `allow=`
is not a lever here; the `sandbox` attribute is the only one.

```html
<iframe src="https://torrent.fkn.app/download?magnet=..."
        sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>
```

Omitting `sandbox` entirely works too. When the page detects it is framed by another origin it
offers a link to open itself top-level, which is the way out if the embedder cannot grant the flag.

Two other consequences of being framed, both handled: Chrome refuses `showSaveFilePicker` in a
cross-origin frame, so the page does not ask for one, and delivery goes through the service worker
instead.

## Tests

| command | what it covers | cost |
| --- | --- | --- |
| `npm test` | pure logic in node | ~1s |
| `npm run test:browser` | components in real Chrome | ~2s |
| `npx tsc --noEmit` | types | ~1s |
| `npx vp lint` | oxlint, type aware | ~1s |
| `npm run test:download` | the download page against a real torrent, end to end | ~30s |
| `npm run test:e2e` | the engine against real swarms | minutes, headful |
| `npm run test:e2e:rig` | the whole chain against a local swarm, see below | ~90s, headful under Xvfb |

The playwright suites run headful on purpose: headless Chromium stalls the engine at a flat 0 B/s in
every topology, which makes anything torrent-shaped unmeasurable rather than merely slow.

### The swarm rig

`e2e:rig` downloads a torrent that exists only on this machine. The seeders are transmission daemons
on `127.0.0.2` and up, the relay is a local webvpn build, and the broker is a local fkn-client web
build, so the only source of a byte is the fleet the magnet names. The public swarm cannot give that:
byte-identical code measured 14.7 s to 73.4 s to first frame there.

| piece | where | port |
| --- | --- | --- |
| broker (fkn-client `web`, development build) | `http://localhost:5234/api` | 5234 |
| relay (webvpn release build) | WebTransport, HTTP, WebSocket on `127.0.0.1` | 5433, 5434, 5443 |
| ripple (`build/`, served) | `http://localhost:5460` | 5460 |
| seeders (transmission 4) | `127.0.0.2:52600` and up, rpc `9400` and up | |

None of it overlaps fkn/local's rig (1234, 3000, 4433, 4560, 8443), so the two run side by side. The
ports live in `tests/swarm-rig/topology.json`.

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

`test:e2e:rig` runs three steps:

1. `scripts/rig-prepare.mjs` builds `@fkn/lib` with `VITE_WEB_ORIGIN=http://localhost:5234` and the
   web app as the broker, then checks what each build baked in. It refuses a main worktree.
2. `npm run build`, which sees `RIPPLE_RIG_FKN_CLIENT` and resolves `@fkn/lib` to that local build
   (the published lib has `https://fkn.app` baked in, and no setting of ripple's can move it). The
   build warns when it does this. Afterwards `build/` points at the rig's broker, so rebuild without
   the variable before serving it for anything else.
3. `playwright.rig.config.ts` starts the relay (the environment `byo.sh webvpn --export` prints, moved
   to the rig's ports, with a fresh certificate and `FREE_RATE_BYTES_PER_SEC` at 1 GiB/s), the broker
   and ripple, then runs `tests/swarm-rig.spec.ts`.

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

Knobs: `RIPPLE_RIG_SEEDERS` (default 4), `RIPPLE_RIG_BUDGET_MS` (swarm arm, 120000),
`RIPPLE_RIG_CONTROL_MS` (30000), `RIPPLE_RIG_STATE` (fixture and seeder state, default
`$TMPDIR/ripple-swarm-rig`). The config refuses to start when `WAYLAND_DISPLAY` or `NIXOS_OZONE_WL`
is set, because the Nix Chrome wrapper then opens a real window even under `xvfb-run`.

The engine's DHT is on, and it announces the infohash through the relay. So the control can see a
stray peer (1 peer in two of three runs, 0 bytes each time). This is why the seeders' own upload
count is part of the claim.
