// Stub for WebTorrent's "browser exclude" deps (bittorrent-dht, etc.). The fork
// disables them in-browser, but its entry still imports the symbols by name, and
// vite's __vite-browser-external stub has no named exports. This satisfies both
// the named `Client` import and any default import with a harmless no-op.

export class Client {}
export default Client
