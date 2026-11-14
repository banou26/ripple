// A proxy that carries nothing: it notes the host of every connection a browser asks it for and refuses each, so a
// test reads which hosts a page and its workers reach while nothing leaves this machine.
import { createServer } from 'node:http'

/**
 * @returns {Promise<{ port: number, hosts: () => string[], close: () => Promise<void> }>} `hosts` is every host
 * asked for so far, each once, in the order it was first asked.
 */
export const startProxy = async () => {
  const asked = new Set()
  const server = createServer((request, response) => {
    // a plain http request through a proxy names the whole URL
    try { asked.add(new URL(request.url).hostname) } catch { /* not a proxied request */ }
    response.writeHead(502).end()
  })
  // https and WebSockets, which ask for a tunnel to host:port
  server.on('connect', (request, socket) => {
    asked.add(request.url.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    hosts: () => [...asked],
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
