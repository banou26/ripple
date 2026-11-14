// What an engine worker holds at the relay, and that all of it is closed before the worker is ended: the relay
// keeps a socket until it is closed, takes peers on it and counts what arrives.
import { afterEach, expect, it, vi } from 'vitest'

import { relaySockets } from '../../src/torrent/relay-sockets'

type Listener = (...args: unknown[]) => void

/** FKN's net and dgram as the relay behaves: a bind is answered a moment later, a close is confirmed a moment later. */
const relay = ({ refuse = false, answers = true } = {}) => {
  const held = new Set<string>()
  const later = (answer: () => void) => { if (answers) setTimeout(answer, 1) }
  const emitter = () => {
    const listeners = new Map<string, Listener[]>()
    const on = (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) }
    return { on, once: on, emit: (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args) } }
  }
  let made = 0
  const bindable = (kind: string) => {
    const name = `${kind} ${++made}`
    const socket = {
      ...emitter(),
      name,
      /** A bind the test answers itself, for one still on its way when the worker is asked to close. */
      granted: () => { held.add(name); socket.emit('listening') },
      bind: () => later(() => refuse ? socket.emit('error', new Error('refused')) : socket.granted()),
      listen: () => socket.bind(),
      close: () => later(() => { held.delete(name); socket.emit('close') }),
    }
    return socket
  }
  const connection = (kind = 'connection') => {
    const name = `${kind} ${++made}`
    held.add(name)
    const socket = { ...emitter(), name, destroy: () => later(() => { held.delete(name); socket.emit('close') }) }
    return socket
  }
  return {
    held,
    connection,
    net: { connect: () => connection(), createServer: () => bindable('listener') },
    dgram: { createSocket: () => bindable('udp') },
  }
}

afterEach(() => { vi.useRealTimers() })

it('closes the listener, the connections it took, the UDP sockets and the dialled connections, and waits for the relay', async () => {
  const fkn = relay()
  const sockets = relaySockets(fkn)
  sockets.dgram.createSocket({ type: 'udp4' }).bind(0)
  sockets.dgram.createSocket('udp4').bind(0)
  const server = sockets.net.createServer()
  server.listen(0)
  sockets.net.connect({ host: '198.51.100.20', port: 6881 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  server.emit('connection', fkn.connection('accepted'))
  // THE CONTROL: all five are the relay's until somebody closes them
  expect([...fkn.held].sort()).toEqual(['accepted 5', 'connection 4', 'listener 3', 'udp 1', 'udp 2'])

  // read at the moment it resolves: the worker is ended then, and the relay keeps whatever is left
  expect(await sockets.close().then(() => [...fkn.held])).toEqual([])
})

it('closes a socket whose bind was still on its way, as soon as the relay answers it', async () => {
  const fkn = relay()
  const sockets = relaySockets(fkn)
  const late = sockets.dgram.createSocket('udp4')
  let closed = false
  const closing = sockets.close().then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(closed, 'the worker would be ended with a bind on its way').toBe(false)
  late.granted()
  expect([...fkn.held]).toEqual(['udp 1'])
  await closing
  expect([...fkn.held]).toEqual([])
})

it('does not wait for a bind the relay refused, nor for a socket that closed by itself', async () => {
  const fkn = relay({ refuse: true })
  const sockets = relaySockets(fkn)
  sockets.dgram.createSocket('udp4').bind(0)
  sockets.net.createServer().listen(0)
  const gone = sockets.net.connect({ host: '198.51.100.20', port: 6881 })
  gone.destroy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  vi.useFakeTimers()
  let closed = false
  void sockets.close().then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(closed, 'waited on a socket the relay does not hold').toBe(true)
})

it('gives a relay that never answers one second, then lets the worker be ended', async () => {
  vi.useFakeTimers()
  const fkn = relay({ answers: false })
  const sockets = relaySockets(fkn)
  sockets.net.connect({ host: '198.51.100.20', port: 6881 })
  let closed = false
  void sockets.close().then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(999)
  expect(closed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(closed).toBe(true)
})

// an engine opens a socket again when one closes under it, 250 ms later at the soonest
it('hands out nothing of the relay once it was closed, and what it hands out fails as a host with no network does', async () => {
  const fkn = relay()
  const sockets = relaySockets(fkn)
  await sockets.close()
  const udp = sockets.dgram.createSocket({ type: 'udp4' })
  udp.bind(0)
  sockets.net.createServer().listen(0)
  const refused = new Promise<{ errno?: number }>((resolve) => sockets.net.connect({ host: '198.51.100.20', port: 6881 }).on('error', resolve))
  expect((await refused).errno).toBeTypeOf('number')
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect([...fkn.held]).toEqual([])
})
