import type { ActorRefFrom } from 'xstate'
import { createMachine, createActor, assign, fromPromise } from 'xstate'

import { TorrentDocument, getSettingsDocument, torrentCollection } from '../database'
import { torrentMachine } from './torrent'

const getTorrentDocuments = () => torrentCollection.find().exec()

export const torrentManagerMachine = createMachine({
  id: 'torrentManager',
  initial: 'waitingForDocuments',
  context: {
    torrentDocuments: [] as TorrentDocument[],
    torrents: [] as ActorRefFrom<typeof torrentMachine>[],
    workerReady: false
  },
  types: {
    events: {} as {
      TORRENT: {
        ADD: {
          output: TorrentDocument
        },
        REMOVE: {
          output: TorrentDocument
        },
        PAUSE: {
          output: TorrentDocument
        },
        RESUME: {
          output: TorrentDocument
        },
        'REMOVE-AND-DELETE-FILES': {
          output: TorrentDocument
        },
        'REMOVE-AND-KEEP-FILES': {
          output: TorrentDocument
        }
      },
      WORKER: {
        READY: {},
        DISCONNECTED: {}
      }
    }
  },
  on: {
    'WORKER.DISCONNECTED': {
      actions: assign({
        workerReady: false
      })
    },
    'WORKER.READY': {
      actions: assign({
        workerReady: true
      })
    },
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
          console.log('waitingForWorker EXIT')
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
      always: {
        target: 'idle',
        guard: ({ context }) => console.log('waitingForWorker always guard', context.workerReady) || context.workerReady
      },
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
        },
        'TORRENT.REMOVE': {
          actions: assign({
            torrents: ({ context, event }) => {
              const torrent = context.torrents.find(torrent => torrent.id === `torrent-${event.output.infoHash}`)
              torrent?.stop()
              return context.torrents.filter(torrent => torrent.id !== `torrent-${event.output.infoHash}`)
            }
          })
        },
        'TORRENT.PAUSE': {
          actions: assign({
            torrents: ({ context, event }) => {
              const torrent = context.torrents.find(torrent => torrent.id === `torrent-${event.output.infoHash}`)
              torrent?.send({ type: 'TORRENT.PAUSE' })
              return context.torrents
            }
          })
        },
        'TORRENT.RESUME': {
          actions: assign({
            torrents: ({ context, event }) => {
              const torrent = context.torrents.find(torrent => torrent.id === `torrent-${event.output.infoHash}`)
              torrent?.send({ type: 'TORRENT.RESUME' })
              return context.torrents
            }
          })
        },
        'TORRENT.REMOVE-AND-DELETE-FILES': {
          actions: assign({
            torrents: ({ context, event }) => {
              const torrent = context.torrents.find(torrent => torrent.id === `torrent-${event.output.infoHash}`)
              torrent?.send({ type: 'TORRENT.REMOVE-AND-DELETE-FILES' })
              return context.torrents
            }
          })
        },
        'TORRENT.REMOVE-AND-KEEP-FILES': {
          actions: assign({
            torrents: ({ context, event }) => {
              const torrent = context.torrents.find(torrent => torrent.id === `torrent-${event.output.infoHash}`)
              torrent?.send({ type: 'TORRENT.REMOVE-AND-KEEP-FILES' })
              return context.torrents
            }
          })
        },
        'PAUSE': {
          actions: assign({
            torrents: ({ context, event }) => {
              console.log('EVENT', event)
              context.torrents.forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))
              return context.torrents
            }
          }),
          target: 'paused'
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
        'RESUME': {
          actions: assign({
            torrents: ({ context, event }) => {
              console.log('EVENT', event)
              context.torrents.forEach(torrent => torrent.send({ type: 'TORRENT.RESUME' }))
              return context.torrents
            }
          }),
          target: 'paused'
        },
      }
    }
  }
})

export type TorrentManagerMachine = typeof torrentManagerMachine

const manager =
  createActor(torrentManagerMachine)
    .start()

getSettingsDocument().then(settingsDocument => {
  settingsDocument?.$.subscribe(settings => {
    if (settings?.paused) {
      manager.send({ type: 'PAUSE' })
    } else {
      manager.send({ type: 'RESUME' })
    }
  })
})

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
