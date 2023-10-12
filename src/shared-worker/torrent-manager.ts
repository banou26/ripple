import type { ActorRefFrom } from 'xstate'
import { createMachine, createActor, assign, fromPromise } from 'xstate'

import { TorrentDocument, torrentCollection } from '../database'
import { torrentMachine } from './torrent'

const getTorrentDocuments = () => torrentCollection.find().exec()

export const torrentManagerMachine = createMachine({
  id: 'torrentManager',
  initial: 'waitingForDocuments',
  context: {
    torrentDocuments: [] as TorrentDocument[],
    torrents: [] as ActorRefFrom<typeof torrentMachine>[]
  },
  on: {
    'WORKER.DISCONNECTED': { target: '.waitingForWorker' },
  },
  states: {
    waitingForDocuments: {
      invoke: {
        id: 'getTorrentDocuments',
        src: fromPromise(getTorrentDocuments),
        onDone: {
          target: 'waitingForWorker',
          actions: assign({
            torrentDocuments: ({ event }) => event.output
          })
        },
        onError: {}
      }
    },
    waitingForWorker: {
      entry: assign({
        torrents: ({ context }) => {
          context.torrents.forEach(torrent => torrent.stop())
          return []
        }
      }),
      exit: assign({
        torrents: ({ spawn, context, self }) => {
          context.torrents.forEach(torrent => torrent.stop())
          return context.torrentDocuments.map(torrent => {
            return spawn(
              torrentMachine,
              {
                id: `torrent-${torrent.infoHash}`,
                input: {
                  parent: self,
                  document: torrent
                }
              }
            )
          })
        }
      }),
      on: {
        'WORKER.READY': 'idle'
      }
    },
    idle: {
      on: {
        'TORRENT.ADD': {
          actions: assign({
            torrents: ({ spawn, context, event, self }) => [
              ...context.torrents,
              spawn(
                torrentMachine,
                {
                  id: `torrent-${event.output.infoHash}`,
                  input: {
                    parent: self,
                    document: event.output
                  }
                }
              )
            ]
          })
        }
      }
    },
    paused: {
      invoke: {
        id: 'getTorrentDocuments',
        input: ({ context }) => context,
        src: fromPromise(async ({ input }: { input: { torrents: ActorRefFrom<typeof torrentMachine>[] } }) => {
          input.torrents.forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))
        }),
      },
      on: {
        'RESUME': 'idle'
      }
    }
  }
})

export type TorrentManagerMachine = typeof torrentManagerMachine

const manager =
  createActor(torrentManagerMachine)
    .start()

setTimeout(() => {
  console.log('manager', manager.getSnapshot())
  console.log(
    'torrents',
    Object.fromEntries(
      Object
        .entries(manager.getSnapshot().children)
        .map(([key, actor]) => [
          key,
          actor.getSnapshot()
        ])
    )
  )
  console.log(
    'torrentsFiles',
    Object.fromEntries(
      Object
        .entries(manager.getSnapshot().children)
        .flatMap(([key, actor]) =>
          Object
            .entries(actor.getSnapshot().children)
            .map(([key, actor]) => [
              key,
              actor.getSnapshot()
            ])
        )
    )
  )
}, 500)

export default manager
