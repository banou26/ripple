import * as fknNet from '@fkn/lib/net'
import * as fknDgram from '@fkn/lib/dgram'
import { offlineHost } from 'libtorrent-wasm'

// how long the relay gets to answer each close, and each bind still on its way, before the worker is ended anyway
const CLOSE_MS = 1_000

// `on` alone, which is all the engine asks of a host's sockets
type Emitter = { on: (event: string, listener: (...args: any[]) => void) => unknown }
type Connection = Emitter & { destroy: () => unknown }

/**
 * FKN's `net` and `dgram` for one engine worker, with a way to hand back all of it.
 *
 * The relay keeps a socket until it is closed, and a worker that is ended closes none: its listener, its UDP
 * sockets and its connections stayed at the relay, took peers and were counted for as long as the page was open.
 * So a worker is asked to `close` before it is ended. That closes every listener, socket and connection opened
 * through this, one whose bind has not been answered yet as soon as it is, and resolves once the relay has let
 * each go, or after a second. Whatever is asked for afterwards carries nothing, since an engine opens a socket
 * again when one closes under it.
 */
export const relaySockets = ({ net, dgram }: { net: any, dgram: any } = { net: fknNet, dgram: fknDgram }) => {
  const held = new Map<Promise<void>, () => void>()
  let nothing: ReturnType<typeof offlineHost> | null = null

  const hold = (gone: Promise<void>, close: () => void) => {
    held.set(gone, close)
    void gone.then(() => held.delete(gone))
  }
  /**
   * A UDP socket or a listener, held from the moment its bind is asked: the engine makes sockets it never binds,
   * which hold nothing at the relay and never say anything, and waiting for one would be waiting the whole second.
   */
  const bound = (socket: any, bind: 'bind' | 'listen') => {
    const ask = socket[bind]
    socket[bind] = (...args: unknown[]) => {
      let listening = false
      socket.on('listening', () => { listening = true })
      hold(
        new Promise((resolve) => {
          socket.on('close', resolve)
          // a bind the relay refused holds nothing there, and no close follows it
          socket.on('error', () => { if (!listening) resolve() })
        }),
        () => { if (listening) socket.close(); else socket.on('listening', () => socket.close()) },
      )
      return ask.apply(socket, args)
    }
    return socket
  }
  const connection = <T extends Connection>(socket: T) => {
    hold(new Promise((resolve) => socket.on('close', resolve)), () => socket.destroy())
    return socket
  }

  return {
    net: {
      connect: (...args: unknown[]) => nothing ? nothing.net.connect() : connection(net.connect(...args)),
      createServer: () => {
        if (nothing) return nothing.net.createServer()
        const server = bound(net.createServer(), 'listen')
        server.on('connection', connection)
        return server
      },
    },
    dgram: {
      createSocket: (...args: unknown[]) => nothing ? nothing.dgram.createSocket() : bound(dgram.createSocket(...args), 'bind'),
    },
    close: (): Promise<unknown> => {
      nothing ??= offlineHost()
      // one that throws must not keep the rest open
      for (const close of held.values()) try { close() } catch { /* it holds nothing */ }
      return Promise.race([Promise.all(held.keys()), new Promise((resolve) => setTimeout(resolve, CLOSE_MS))])
    },
  }
}

export type RelaySockets = ReturnType<typeof relaySockets>
