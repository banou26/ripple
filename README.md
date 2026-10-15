# Ripple

Download and stream torrents in your browser. Ripple runs a real BitTorrent engine
([libtorrent](https://www.libtorrent.org), compiled to WebAssembly) in the page, reaches peers
through the [FKN](https://fkn.app) relay, and plays a video while it downloads. There is nothing to
install and no Ripple server.

- Live at [torrent.fkn.app](https://torrent.fkn.app), and inside FKN at
  [fkn.app/app/npm:@banou/ripple](https://fkn.app/app/npm:@banou/ripple)
- Published on npm as [`@banou/ripple`](https://www.npmjs.com/package/@banou/ripple)

## Features

- **Add a magnet or a `.torrent`.** Paste it, drop it, or open it from your system once Ripple is
  installed as an app, which then opens `magnet:` links and `.torrent` files.
- **Watch while it downloads**, with subtitles, a choice of audio track and a Normalize volume
  switch.
- **Pick the files you want** before the download starts.
- **Keep files in the browser or in a folder on your disk**, and save one file, or a zip of
  several.
- **Create a torrent** from files or a folder (v1, v2 or hybrid, private with a source tag, web
  seeds) and seed it straight from those files.
- **Your library on every device.** Signed in to FKN, your list and its thumbnails sync, encrypted
  in your browser before they leave it.
- **Share links** that open the player or a download page, which other sites can embed.
- **One engine for all your tabs.** One tab runs it and the others use it.
- **Speed limits** for everything or per torrent, and the peers, trackers, files and all-time share
  ratio of each torrent.
- **No Ripple account and no analytics.**

## How it is built

- **UI**: React 19, routed with React Router 7 and styled with Emotion, in `src/router` and
  `src/components`.
- **Engine**: [`libtorrent-wasm`](https://www.npmjs.com/package/libtorrent-wasm) in a Web Worker
  (`src/torrent/worker.ts`), driven from the page by `src/torrent/client.ts`. One tab holds it
  under a Web Lock and the others reach it over a BroadcastChannel (`engine-election.ts`,
  `engine-share.ts`).
- **Network**: `@fkn/lib/net` and `@fkn/lib/dgram`, carried through the FKN relay (`relayWorker`
  bridges the worker). Inbound peers reach a port the relay reserves.
- **Storage**: OPFS, or a folder you grant (`src/torrent/hybrid-storage.ts`). The list, resume data
  and thumbnails are in IndexedDB.
- **Player**: [`@banou/media-player`](https://www.npmjs.com/package/@banou/media-player) at
  `/watch` (`src/router/embed.tsx`), with libav-wasm and jassub.
- **Sync**: `src/torrent/use-cloud-backup.ts` and `src/torrent/thumbnail-sync.ts`, under `ripple/`
  in the FKN account's storage.

## Development

Use Node 24 (`.node-version` names 24.21.0).

```sh
npm ci
npm run dev            # http://localhost:4560
npm run build          # the site and the npm package, into build/
npm test               # unit tests (vitest, node)
npm run test:browser   # component tests in Chrome
npm run typecheck
npm run lint           # vp lint
```

The Playwright suites build first, then drive the built site in Chrome:

| command | what it covers |
| --- | --- |
| `npm run test:e2e:local` | the app, needing nothing but the browser (and ffmpeg) |
| `npm run test:e2e:machine` | live figures keep their width, which depends on the machine's fonts |
| `npm run test:e2e:swarm` | the engine against real public swarms |
| `npm run test:e2e:rig` | the whole chain against a local swarm, see [tests/swarm-rig](./tests/swarm-rig/README.md) |

The swarm and rig suites need a headful Chrome, because headless Chromium stalls the engine at
0 B/s. Run them under `xvfb-run -a -s "-screen 0 1280x720x24"` so no window opens.

A push to `main` deploys [torrent.fkn.app](https://torrent.fkn.app) (Cloudflare Pages), and
publishes to npm when `package.json` names a version the registry does not have yet
(`.github/workflows/publish-lib.yml`). Each published version is signed for FKN with `fkn-sign`.

## Embedding

`/watch` and `/download` are the pages another site puts in an iframe. Both take a magnet and the
same query; the path chooses which one renders. `/watch` plays a file, `/download` delivers files.

| param | value | meaning |
| --- | --- | --- |
| `magnet` | base64 of the magnet URI | the form to write; permanent |
| `m` | the packed magnet, base64url | what Ripple's own share links write |
| `fileIndex` | a file index | the file `/watch` plays (0 if absent); the fallback `/download` uses |
| `files` | `all`, `3`, `0-4`, `0,2,5` | what `/download` delivers |
| `f` | a packed file list | optional, `/download` only: shown until the torrent's own list arrives |

One of `magnet` or `m` is required, and `m` is read first when both are present. `magnet=` is the
original form and every link written with it keeps working. `m=` is the same torrent packed into a
much shorter link.

```
/watch?magnet=<base64>&fileIndex=3     plays file 3
/download?magnet=<base64>              the whole torrent
/download?magnet=<base64>&files=3      just file 3
/download?magnet=<base64>&files=0-4    files 0 to 4 inclusive, as a zip
/download?magnet=<base64>&files=0,2,5  those three, as a zip
/download?magnet=<base64>&fileIndex=3  same as files=3
```

One file is delivered as that file, and more than one as a single `.zip`. `files` outranks
`fileIndex`. Indices the torrent does not have are dropped, and a selection that resolves to
nothing says so instead of downloading the whole torrent.

**A sandboxed frame needs `allow-downloads`**, or the browser drops the download without an error.
Leaving out `sandbox` works too.

```html
<iframe src="https://torrent.fkn.app/download?magnet=..."
        sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>
```

Why each part works the way it does is in [docs/embedding.md](./docs/embedding.md).

## Privacy

Ripple needs no account and runs no analytics. Your list and your files stay in your browser, or in
a folder you choose. Signed in to FKN, your list and its thumbnails sync to your FKN account,
encrypted in your browser first. Peers see the FKN relay's address, not yours. The
[privacy page](https://torrent.fkn.app/privacy) lists what Ripple keeps
(`src/router/privacy.tsx`).

## License

MIT, see [LICENSE](./LICENSE).
