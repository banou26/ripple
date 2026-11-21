// A browser test because the client registers window listeners as it is built.

import { afterEach, expect, it } from 'vitest'

import type { StorageFull } from '../../src/torrent/storage-budget'
import type { Transport, TransportHost } from '../../src/torrent/engine-protocol'

import { createTorrentClient } from '../../src/torrent/client'

const clients: ReturnType<typeof createTorrentClient>[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

it('passes on a full origin that stops only the person\'s own downloads, to a page that listens later too', () => {
  let host!: TransportHost
  const client = createTorrentClient()
  clients.push(client)
  client.useTransport((h: TransportHost): Transport => {
    host = h
    return { post: () => {}, destroy: () => {}, pending: () => [] }
  }, true)
  host.message({ type: 'ready' })
  const heard: StorageFull[] = []
  client.onStorageFull((full) => heard.push(full))

  host.message({ type: 'storage-full', full: 'kept' })
  const later: StorageFull[] = []
  client.onStorageFull((full) => later.push(full))
  host.message({ type: 'storage-full', full: true })
  host.message({ type: 'storage-full', full: false })
  expect(heard).toEqual(['kept', true, false])
  expect(later).toEqual(['kept', true, false])
})
