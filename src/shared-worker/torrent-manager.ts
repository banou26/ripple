import type { ActorRefFrom } from 'xstate'
import { filter, first, from, mergeMap, switchMap, tap } from 'rxjs'
import { createMachine, createActor, assign, fromPromise, fromObservable } from 'xstate'

import { SettingsDocument, TorrentDocument, getSettingsDocument, torrentCollection } from '../database'
import { torrentMachine } from './torrent'
import { torrent } from '@fkn/lib'

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
                },
                syncSnapshot: true
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
      invoke: {
        input: ({ context }) => context,
        src:
          fromObservable(({ input }) => {
            input
              .torrents
              .filter(torrent => torrent.getSnapshot().value !== 'finished')
              .forEach(torrent => torrent.send({ type: 'TORRENT.RESUME' }))

            return (
              from(getSettingsDocument())
                .pipe(
                  mergeMap((settingsDocument) => settingsDocument?.$),
                  filter((settingsDocument) => settingsDocument?.paused),
                  first(),
                )
            )
          }),
        onDone: {
          target: 'paused'
        }
      },
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
              console.log('EVENT', event, context)
              context
                .torrents
                .filter(torrent => torrent.getSnapshot().value !== 'finished')
                .forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))
              return context.torrents
            }
          }),
          target: 'paused'
        }
      }
    },
    paused: {
      // invoke: {
      //   id: 'getTorrentDocuments',
      //   input: ({ context }) => context,
      //   src: fromPromise(async ({ input }: { input: { torrents: ActorRefFrom<typeof torrentMachine>[] } }) => {
      //     input
      //       .torrents
      //       .filter(torrent => console.log('TORRENT STATE', torrent.getSnapshot().value) || torrent.getSnapshot().value !== 'finished')
      //       .forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))
      //   }),
      // },
      invoke: {
        id: 'paused status watch',
        input: ({ context }) => context,
        src:
          fromObservable(({ context, input }) => {
            input
              .torrents
              .filter(torrent => torrent.getSnapshot().value !== 'finished')
              .forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))

            return (
              from(getSettingsDocument())
                .pipe(
                  mergeMap((settingsDocument) => settingsDocument?.$),
                  filter((settingsDocument) => !settingsDocument?.paused),
                  first()
                )
            )
          }),
        onDone: {
          target: 'idle'
        }
      },
      on: {
        'RESUME': {
          actions: assign({
            torrents: ({ context, event }) => {
              console.log('EVENT', event, context)
              context
                .torrents
                .filter(torrent => torrent.getSnapshot().value !== 'finished')
                .forEach(torrent => torrent.send({ type: 'TORRENT.RESUME' }))
              return context.torrents
            }
          }),
          target: 'idle'
        }
      }
    }
  }
})

export type TorrentManagerMachine = typeof torrentManagerMachine

const manager =
  createActor(torrentManagerMachine)
    .start()

// getTorrentDocuments()
//   .then((torrentDocuments) => {

//   })

torrentCollection.find().$.subscribe((torrentDocuments) => {
  console.log('torrentDocuments', torrentDocuments)
})

manager.subscribe((state) => {
  console.log(
    'manager state',
    ...[
      // ...(
      //   state
      //     .context
      //     .torrents
      //     .map((actor) => actor.getSnapshot().context)
      // ),
      ...(
        state
        .context
        .torrents
        .flatMap((actor) =>
          actor
            .getSnapshot()
            .context
            .files
            .map((actor) => ({...actor.getSnapshot().context}))
        )
      )
    ]
  )
})


// setTimeout(() => {
//   console.log('manager', manager.getSnapshot())
//   console.log(
//     'torrents',
//     Object.fromEntries(
//       Object
//         .entries(manager.getSnapshot().children)
//         .map(([key, actor]) => [
//           key,
//           actor.getSnapshot()
//         ])
//     )
//   )
//   console.log(
//     'torrentsFiles',
//     Object.fromEntries(
//       Object
//         .entries(manager.getSnapshot().children)
//         .flatMap(([key, actor]) =>
//           Object
//             .entries(actor.getSnapshot().children ?? {})
//             .map(([key, actor]) => [
//               key,
//               actor.getSnapshot()
//             ])
//         )
//     )
//   )
// }, 1000)

export default manager
