# Writing a Ripple plugin

A Ripple plugin is an FKN package. Ripple connects to it with the protocol `ripple-plugin@1`, hands it calls that act on
the person's torrents, and draws the buttons it asks for. The plugin runs in fkn.app's hidden frame, on an origin of
its own, never in Ripple's page.

A person adds a plugin in Ripple's Settings, under Plugins: **Browse** opens fkn.app's list of the npm packages that
carry the keywords `fkn`, `fkn-type:plugin` and `fkn-plugin--ripple`, and **Add** takes a package's address, such as
`npm:ripple-plugin-example`. Either way fkn.app asks first, then Ripple asks which of the plugin's switches to turn on,
each one off.

[`examples/group-by-tracker`](../examples/group-by-tracker) is a whole plugin, about 90 lines: it puts torrents in a
group named after their tracker, from the header, a torrent's menu and Settings. It is unlisted and not published;
Ripple's tests drive it end to end (`tests/plugins/example.browser.test.tsx`).

## The types

`@banou/ripple` exports the contract's types. Add it as a dev dependency and import types only:

```ts
import type { Ripple, RipplePlugin } from '@banou/ripple'
```

Never import a value from it. The package is Ripple itself, a built site, and its `main` is the app.

## Connecting

The plugin's entry answers each connection with its payload, a `RipplePlugin`, and receives Ripple's calls as the
connection's `remote`:

```ts
import type { Ripple, RipplePlugin } from '@banou/ripple'

import * as packages from '@fkn/lib/packages'

const waiting: ((ripple: Ripple) => void)[] = []

packages.onConnect<Ripple>((info) => {
  if (info.protocol !== 'ripple-plugin@1' || info.brokered !== true) throw new Error('This plugin is for Ripple')
  return createPlugin(new Promise((resolve) => { waiting.push(resolve) }))
}, (connection) => { waiting.shift()?.(connection.remote as unknown as Ripple) })

const createPlugin = (ripple: Promise<Ripple>): RipplePlugin => ({
  asks: ['read', 'change'],
  buttons: (locale) => [{ id: 'sort', place: 'header', label: 'Sort by tracker' }],
  click: async (id, context) => { /* ... */ },
})
```

`brokered` is true only for a background connection fkn.app made, so refuse other background connections. Popup pages
connect with `info.brokered === false` and `remote.page` set: accept those only when you offer popup pages, and trust
only `connection.remote` (never `info.from`). Each Ripple tab connects on its own, and a connection ends when its tab
closes, when the plugin is updated or removed, and when fkn.app reloads its frame. Ripple connects again in the tab that
runs the download engine, and in another tab on its next use.

## Switches

A plugin names the switches it wants in `asks`. Ripple asks the person about each one, off until they turn it on, and
the person can change each one on the plugin's row in Settings at any time. A call whose switch is off, or that the
plugin did not ask for, rejects with `not-allowed`. A switch a newer version asks for is asked about on the person's
next click on one of the plugin's buttons.

| Switch | What the person reads | Calls |
| --- | --- | --- |
| `read` | See your torrents | `torrents`, `torrent`, `groups`, `torrentFile`, and the events `changed`, `added`, `finished`, `removed` |
| `add` | Add torrents without asking | `add` |
| `change` | Pause, resume and organize torrents | `pause`, `resume`, `forceStart`, `recheck`, `reannounce`, `retry`, `start`, `keep`, `setFiles`, `setFirstLast`, `setSequential`, `moveInQueue`, `addTrackers`, `createGroup`, `renameGroup`, `deleteGroup`, `putInGroup`, `takeOutOfGroup` |
| `remove` | Remove torrents | `remove`, `makeTemporary` |
| `files` | Open your downloaded files | `read`, `play`, `save` |
| `folder` | Move files to and from your folder | `folder`, `move` |
| `peers` | See peers and trackers, set speed limits | `peers`, `trackers`, `setLimits`, `sessionLimits`, `setSessionLimits` |
| `network` | See connection status | `network` |

No switch is needed for `version`, `locale`, `dir`, `vpn`, `active`, `page`, `on('vpn' | 'locale' | 'active')`,
`store`, `ui`, `suggest` and the buttons.

## Calls

Every call names a torrent by its info hash, in hex, and returns a promise. A call rejects with one of these as its
error's message:

- `not-allowed`: its switch is off, not asked for, or the call is outside the gesture window (or past the `suggest` limit).
- `not-found`: no torrent or group by that id.
- `unavailable`: the torrent is not running on this device, or the library page is not open for `suggest`.
- `invalid`: an argument is not what the call takes.
- `full`: `store` would pass its 256 KB.

`add(source, options?)` takes `{ magnet }` or `{ torrentFile }` and answers `{ infoHash, outcome }`: `added`, `already`
for a torrent the library keeps (left as it is), or `failed`. Its options work on a .torrent only; for a magnet, choose
its files once `changed` lists them. There is no limit on adds, and everything they download counts toward the
person's daily FKN quota while the VPN is on.

`suggest(source)` proposes a `{ magnet }` or `{ torrentFile }` through Ripple's add dialog, which names the plugin and
asks the person before adding anything. It needs no switch, works while the library page is open, and settles with
`{ infoHash, outcome }`: `added`, `declined` (if the person cancels or closes the library), `already` or `failed`. At
most 10 proposals per gesture window.

**The gesture window:** `ui.open`, `suggest`, `play` and `save` work only while the plugin's popup page is open, or
within 10 s of a click on one of its buttons.

`read(infoHash, file, offset, length, options?)` reads at most 4 MB from a file (including on a temporary torrent). It
does not prioritize missing pieces by default; pass `{ prioritize: true }` to download them, and `{ signal }` to cancel.

`save(infoHash, file?)` streams one file, or the whole torrent as a zip when `file` is omitted, through Ripple's service
worker. It answers `false` when no service worker controls the page or the save is cancelled, and `true` once finished.

`store.get(key)` and `store.set(key, value)` keep strings on this device, 256 KB in all, across the plugin's versions,
since the plugin's own storage starts empty at each version. `set(key, null)` deletes one. Removing the plugin deletes
them.

## What a plugin sees

A torrent crosses as a `PluginTorrent`, a fixed list of fields. Temporary torrents (the ones the player holds) are left
out of `torrents()` and the events; `torrent(infoHash)`, `read` and `play` answer them.

Never handed over, with every switch on:

- **A private tracker's key.** `trackers` holds each tracker's origin alone (`https://t.example`, never its path, query
  or user part), and never its status message. The magnet's `tr=`, `torrentFile` and `addTrackers` work only for a
  torrent whose .torrent this device keeps and says is not private.
- **The person's FKN account,** Ripple's settings (apart from speed limits), other plugins, and the folder or file handles.

## Events

`on(event, listener)` answers a function that stops it.

- `changed`: the torrents that changed, at most once a second, in every Ripple tab.
- `added`, `finished`, `removed`: in the tab running the engine only, where `active` is true. A page load, the engine
  moving to another tab and the account's sync bring torrents in without an `added`.
- `vpn`, `locale` (`{ locale, dir }`) and `active`: when each changes.

Ripple runs plugins only while a Ripple tab is open. Do automatic work, such as following a feed, only where `active`
is true, or each open tab does it once.

## Buttons

`buttons(locale)` answers the plugin's buttons in that language. Ripple draws them with its own icon buttons and
menus, and keeps them per plugin and language, so every tab draws them without connecting. Call `ui.buttonsChanged()`
when they change, a label that says a state for instance; Ripple asks again at most once a second.

| Place | Where | How many | A click's context |
| --- | --- | --- | --- |
| `header` | the library's header, before Create | one per plugin; the first two plugins' are in the header, the rest in its More menu | `{}` |
| `add-field` | the add field, before Open a .torrent file | one per plugin; the first plugin's is inline, the rest in its More menu | `{ text }` |
| `row-menu` | a torrent's menu (right click, and its Options) under the plugin's name | three per plugin | `{ infoHashes: [that torrent's] }` |
| `bulk-bar` | the selection bar, before Remove | one per plugin; the first two plugins' are inline, the rest in its More menu | `{ infoHashes }` |
| `detail` | the details header, before Close | one per plugin; the first two plugins' are inline, the rest in its More menu | `{ infoHash, tab }` |
| `file` | a file's row in Details, beside Save | one per plugin; the first plugin's is inline, the rest in its More menu | `{ infoHash, file }` |
| `player` | the player's top row, beside Open in Ripple | one per plugin; the first plugin's is inline, the rest in its More menu | `{ infoHash, file, time }` |
| `settings` | the plugin's row in Settings | one | `{}` |

- `label`: 40 characters at most, the button's tooltip and accessible name. A button with an empty or longer label is
  left out. Ripple keeps the label in its own direction in a right to left page.
- `icon`: an SVG `data:` url of 4 KB at most, drawn as a mask in Ripple's text colour, so its own colours do not
  matter. `mirror: true` flips it in Arabic and Hebrew; leave it off for a shape that means the same either way. With
  no icon, or any other url, Ripple draws the label's first letter.
- `click(id, context)` should answer within 10 s, or Ripple says the plugin is not responding. Answer once the work is
  done.
- `buttons` should answer within 5 s, or Ripple keeps drawing the buttons it had.
- `page`: `{ id, size? }` opens that popup page directly with the click's context instead of calling `click`.
- A button in a place this Ripple does not draw yet is left out.

## Popup pages

A plugin can show its own UI inside Ripple's dialog, either from a button with `page: { id, size? }` or by calling
`ui.open({ id, size?, context? })` during its gesture window. Ripple mounts the plugin into a sandboxed iframe with
`packages.mount` (`allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`, no top
navigation and no delegated `allow` features). Inside that connection `info.brokered` is `false` and `remote.page` holds
`{ id, context }`, under the same switches as the background connection.

- Sizes are `small` (480 by 360), `medium` (760 by 560, default) and `large` (1100 by 800), capped at the viewport less
  32 by 48 px. Below 600 px wide the card fills the screen in `100dvh`. Over the player the card draws inline inside the
  player's box.
- One popup page is open per tab. If the frame has not loaded within 30 s, Ripple shows one line saying it is not
  responding.
- The page closes on Close, backdrop click, Escape on Ripple's header, `ui.close()`, or when the plugin's background
  connection closes in this tab. Escape inside the frame never reaches Ripple, so listen for Escape in your page and
  call `remote.ui.close()`.

## Languages

Ripple hands `locale` (`en`, `fr`, `pt-BR`, ...) and `dir` (`rtl` in Arabic and Hebrew), and the `locale` event when the
person picks another language. `buttons` is asked once in each language, and again in all of them after
`ui.buttonsChanged()`.

## The VPN

`vpn` says whether the person's VPN is on, and the `vpn` event says when it changes. While it is on, send every request
to a third party through FKN's relay: `fetch` from `@fkn/lib/cloud`, or `@fkn/lib/websocket`, `@fkn/lib/net` and
`@fkn/lib/dgram`.
Never the root `fetch` of `@fkn/lib`, which prefers the browser extension, and load no third-party image, font, style,
frame or script and open no WebRTC connection. While it is off, reach sites with open CORS from the browser itself.
Ripple cannot check any of this, and its privacy page tells the person so.

## Updates and removal

A plugin stays on its version until the person presses Update on its row in Settings. Removing it deletes its
switches, its `store` and its buttons; the torrents it added stay.

## Inside fkn.app

Ripple opened in its own fkn.app tab runs plugins as it does on torrent.fkn.app, with switches of its own. It runs
none in any other frame, the player another site embeds included.

## Building and publishing

Bundle the entry as one ES module, the way [stub-plugin](https://github.com/banou26/stub-plugin) does: Vite's library
mode with `@fkn/vite-plugin`'s `fkn()` plugin, and `main` naming the bundle. Add the three keywords for Browse to list
it; without them the package can still be added by its address.

```ts
import { fkn } from '@fkn/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [fkn()],
  build: { target: 'esnext', lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' } },
})
```

## Testing locally

1. Without FKN: hand the plugin a stand-in for `@fkn/lib/packages`, as Ripple's own tests do.
   [`tests/plugins/packages-double.ts`](../tests/plugins/packages-double.ts) connects a plugin to Ripple over a
   `MessageChannel`, the way fkn.app's broker does, and
   [`tests/plugins/example.browser.test.tsx`](../tests/plugins/example.browser.test.tsx) drives the example through it.
2. In Ripple: serve the folder that holds the plugin's `package.json` and its bundle over HTTPS, and add the plugin in
   Settings by its `https:` address, such as `https:plugins.example.com/group-by-tracker`.
3. For each new build, raise the `version` in its `package.json` and press Update on the plugin's row: FKN keeps a
   plugin on the version it pinned until Update moves it to the version its `package.json` names.

A `localhost:<port>` address, which reads a dev server on your machine, works only with an FKN that runs on your machine
too. torrent.fkn.app refuses it.
