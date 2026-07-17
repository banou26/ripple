---
name: verify
description: Drive Ripple's production build through a real torrent download and capture UI evidence.
---

1. Run `npm run build`.
2. Start `npm run serve` on port 4560. Do not reuse a Vite development server.
3. Launch Chromium through Playwright with `--enable-experimental-web-platform-features`.
4. Set `localStorage['ripple:demo-seeded'] = '1'` before navigation.
5. Open `http://127.0.0.1:4560`, submit the Big Buck Bunny public magnet through the visible form, and wait for transferred bytes.
6. For rate changes, observe worker `state` messages and compare `status.downloadRate` with the speed rendered in `section.stats .stat.big strong`.
7. Capture a screenshot while downloading.
8. Probe pause or resume through the visible torrent-row button and capture the resulting rate and state.

Use a fresh browser context so OPFS and the torrent list do not inherit prior runs. The repository pins Playwright 1.58.0 to match the Nix-provisioned browser revisions.
