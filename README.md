# Ripple, the torrent app that respect your privacy

THE app that allows you to download torrents and stream video files from the safety of your browser!

## Embedding

`/embed` is the page another site puts in an iframe. It takes a magnet and renders one of two things,
chosen by `mode`.

| param | value | meaning |
| --- | --- | --- |
| `magnet` | base64 of the magnet URI | required |
| `mode` | `watch` (default) or `download` | which page to render |
| `fileIndex` | a file index | the file `watch` plays; the fallback `download` uses |
| `files` | `all`, `3`, `0-4`, `0,2,5` | what `download` delivers |

`mode` is absent-safe: anything unrecognised stays the player, so an existing embed URL keeps working
untouched.

### `mode=watch`

The default, and what `/embed?magnet=...` has always been. Plays `fileIndex` (0 if absent) in the
media player, with the filename, peer count and transfer rates drawn over the video.

### `mode=download`

A download page: the release name, the size of the selection, and one button. One file is delivered
as that file; anything more is delivered as a single `.zip`, written straight through to the
browser's own downloader without ever being held in memory.

```
/embed?magnet=<base64>&mode=download                 the whole torrent, as a zip
/embed?magnet=<base64>&mode=download&files=3         just file 3
/embed?magnet=<base64>&mode=download&files=0-4       files 0 to 4 inclusive, as a zip
/embed?magnet=<base64>&mode=download&files=0,2,5     those three, as a zip
/embed?magnet=<base64>&mode=download&fileIndex=3     same as files=3, so &mode=download can simply be
                                                     appended to a watch URL
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
<iframe src="https://torrent.fkn.app/embed?magnet=...&mode=download"
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

The playwright suites run headful on purpose: headless Chromium stalls the engine at a flat 0 B/s in
every topology, which makes anything torrent-shaped unmeasurable rather than merely slow.
