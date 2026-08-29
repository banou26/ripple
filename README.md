# Ripple, the torrent app that respect your privacy

THE app that allows you to download torrents and stream video files from the safety of your browser!

## Embedding

`/embed` is the page another site puts in an iframe. It takes a magnet and renders one of two things,
chosen by `mode`.

| param | value | meaning |
| --- | --- | --- |
| `m` | the packed magnet, base64url | what Ripple writes today |
| `magnet` | base64 of the magnet URI | the original form, read forever |
| `mode` | `watch` (default) or `download` | which page to render |
| `fileIndex` | a file index | the file `watch` plays; the fallback `download` uses |
| `files` | `all`, `3`, `0-4`, `0,2,5` | what `download` delivers |
| `f` | a packed file list | optional preview, `download` only |

One of `m` or `magnet` is required. `m` wins if both are present.

`mode` is absent-safe: anything unrecognised stays the player, so an existing embed URL keeps working
untouched.

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

### `f`, the file list

A magnet names a torrent and nothing else, so a download link normally opens on "Reading the torrent
from the network" for as long as metadata takes. `f` closes that gap by carrying the file list the
sender already had, and the page shows it immediately, marked **from the link**.

It is a preview and Ripple treats it as one. It never decides what gets downloaded: the button stays
disabled until real metadata arrives, the download itself is resolved against that metadata, and the
per-file buttons are not rendered at all while the list is only the link's claim. A link that
describes a torrent inaccurately therefore costs a reader a wrong line on screen for a few seconds,
and can never cost them the wrong file on disk.

Ripple writes it only on `mode=download`, only when it has the list, and only when it fits: a
12-episode season costs about 172 characters and a 48-file season about 416. Past a budget it is
left off entirely rather than pushing the link past what a chat message will carry. Absent, `f`
changes nothing, so a link without it behaves exactly as it always has.

Putting the whole `.torrent` in the URL instead does not work, and the reason is arithmetic rather
than encoding: piece hashes are around 94% of a torrent and are 20 bytes of SHA1 per piece, so they
are incompressible. A 12-episode season is a 28,512-character URL and a 40 GB remux is 68,676. The
file list is the part that is both small and worth having.

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
