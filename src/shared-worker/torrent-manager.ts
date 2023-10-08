import type { Actor, ActorRefFrom } from 'xstate'
import { createMachine, createActor, assign, fromPromise } from 'xstate'

import { TorrentDocument, torrentCollection } from '../database'
import { torrentMachine } from './torrent'

const getTorrents = () => torrentCollection.find().exec()

const torrentManagerMachine = createMachine({
  id: 'torrentManager',
  initial: 'waitingForDb',
  context: {
    torrentDocuments: [] as TorrentDocument[],
    torrents: [] as ActorRefFrom<typeof torrentMachine>[]
  },
  on: {
    'WORKER.DISCONNECTED': {
      actions: ({ context, self }) => {
        context.torrents.forEach(torrent => torrent.stop())
      },
      target: '.waitingForWorker'
    },
    'ADD.TORRENT': {
      actions: assign({
        torrents: ({ spawn, context, event }) => [
          ...context.torrents,
          spawn(torrentMachine, { id: `torrent-${event.output.torrentHash}` })
        ]
      })
    }
  },
  states: {
    waitingForDb: {
      invoke: {
        id: 'getTorrents',
        src: fromPromise(getTorrents),
        onDone: {
          target: 'init',
          actions: assign({
            torrentDocuments: ({ event }) => void console.log('event.output', event.output) || event.output,
            torrents: ({ spawn, context, event }) => [
              ...context.torrents,
              ...event.output.map(({ infoHash }) => spawn(torrentMachine, { id: `torrent-${infoHash}` }))
            ]
          })
        },
        onError: {}
      },
      on: {
        'DB.READY': {
          target: 'init'
        }
      }
    },
    init: {
      entry: assign({
        torrents: ({ spawn }) => [
          spawn(torrentMachine)
        ]
      })
    },
    waitingForWorker: {
      entry: ({ context }) => {
        context
          .torrents
          .forEach(torrent => torrent.stop())
      },
      on: {
        'WORKER.READY': 'idle'
      }
    },
    idle: {
      entry: assign({
        torrents: ({ spawn, context, event }) => [
          ...context.torrents,
          spawn(torrentMachine, { id: `torrent-${event.torrentHash}` })
        ]
      })
    }
  }
})

const manager =
  createActor(torrentManagerMachine)
    .start()

setTimeout(() => {
  console.log('manager', manager.getSnapshot())
}, 500)

export default manager
