import type { ActorRefFrom } from 'xstate'

import type { torrentManagerMachine } from './torrent-manager'

import { createMachine, assign, fromObservable, fromPromise, sendParent, not, stateIn, and, or } from 'xstate'
import ParseTorrent, { toMagnetURI } from 'parse-torrent'

import { Buffer } from 'buffer'
import { SettingsDocument, TorrentDocument, database } from '../database'
import { fileMachine } from './file'
import { from, withLatestFrom } from 'rxjs'
import { deserializeTorrentDocument, deserializeTorrentFile, serializeTorrentDocument, serializeTorrentFile } from '../database/utils'
import { RxDocument } from 'rxdb'
import { torrentFile } from '@fkn/lib'

export const getTorrentProgress = (torrentState: TorrentDocument['state']) => {
  const selectedFiles = torrentState.files?.filter(file => file.selected) ?? []
  const totalLength = selectedFiles.reduce((acc, file) => acc + file.length, 0)
  const downloadedLength = selectedFiles.reduce((acc, file) => acc + file.downloaded, 0)
  return downloadedLength / totalLength
}

export const getTorrentStatus = () => {

}


// always: [{
//   actions: [
//     // assign(({ context, event, self }) => console.log('idle always actions assign', event, context, self) || {
//     //   lastEvent: event
//     // })
//   ],
//   // guard: ({ context, event }) => context.lastEvent !== event
// }] as const,

export const torrentMachine = createMachine({
  initial: 'init',
  context: (
    { input }:
    {
      input: {
        settingsDbDocument: RxDocument<SettingsDocument>
        infoHash: string
        magnet: string
        torrentFile?: ParseTorrent.Instance
        document: TorrentDocument
        dbDocument?: RxDocument<TorrentDocument>
      }
    }
  ) => ({
    settingsDbDocument: input.settingsDbDocument,

    infoHash: input.infoHash,
    magnet: input.magnet,
    torrentFile: input.torrentFile,
    
    shouldRemoveFiles: false,

    lastEvent: null as unknown,
    document: input.document,
    dbDocument: input.dbDocument,
    files: [] as ActorRefFrom<typeof torrentMachine>[]
  }),
  types: {
    events: {} as
    | { type: 'TORRENT.ADD', input: { infoHash: string, magnet: string, torrentFile: ParseTorrent.Instance | undefined }, output: TorrentDocument }
    | { type: 'TORRENT.PAUSE' }
    | { type: 'TORRENT.RESUME' }
    | { type: 'TORRENT.REMOVE-AND-DELETE-FILES', output: TorrentDocument }
    | { type: 'TORRENT.REMOVE-AND-KEEP-FILES', output: TorrentDocument }
    | { type: 'FILE.CHECKING' }
    | { type: 'FILE.FINISHED' }
    | { type: 'FILE.SELECT' }
    | { type: 'FILE.UNSELECT' }
  },
  always: [{
    actions: [
      async ({ context, event, self }) => {
        const files = context.files.map(file => file.getSnapshot().context)

        if (
          !context.document || !context.dbDocument ||
          event.type === 'TORRENT.REMOVE-AND-KEEP-FILES' || event.type === 'TORRENT.REMOVE-AND-DELETE-FILES'
        ) {
          return
        }

        const doc = {
          ...context.document,
          state: {
            ...context.document.state,
            torrentFile:
              context.document.state.torrentFile
              && deserializeTorrentFile(context.document.state.torrentFile)
          }
        }

        const currentStatus = self.getSnapshot().value

        const totalLength = files.reduce((acc, file) => acc + file.length, 0)
        const downloaded = files.reduce((acc, file) => acc + file.downloaded, 0)
        const downloadSpeed =
          currentStatus === 'downloading'
          ? files.reduce((acc, file) => acc + file.downloadSpeed, 0)
          : 0
        const remainingTime = (totalLength - downloaded) / downloadSpeed

        const { infoHash, ...newDocument } = serializeTorrentDocument({
          state: {
            name: doc.state.name,
            status: currentStatus,
            progress:
              files
                .filter(file => file.selected)
                .reduce((acc, file) => acc + file.progress, 0)
              / (
                files
                  .filter(file => file.selected)
                  .length
              ),
            size: doc.state.size,
            peers: doc.state.peers,
            proxy: doc.state.proxy,
            p2p: doc.state.p2p,
            addedAt: doc.state.addedAt,
            remainingTime,
            peersCount: doc.state.peersCount,
            seedersCount: doc.state.seedersCount,
            leechersCount: doc.state.leechersCount,
            downloaded,
            uploaded: files.reduce((acc, file) => acc + file.uploaded, 0),
            downloadSpeed,
            uploadSpeed: files.reduce((acc, file) => acc + file.uploadSpeed, 0),
            ratio: doc.state.ratio,
            files: files.map((file, i) => ({
              index: i,
              name: file.name,
              path: file.path,
              pathArray: file.pathArray,
              offset: file.offset,
              length: file.length,
              downloaded: file.downloaded,
              progress: file.progress,
              selected: file.selected,
              priority: file.priority,
              downloadedRanges: file.downloadedRanges.map(range => ({
                start: range.start,
                end: range.end
              })),
              downloadSpeed: file.downloadSpeed,
              streamBandwithLogs: file.streamBandwithLogs.map(log => ({
                byteLength: log.byteLength,
                timestamp: log.timestamp
              }))
            })),
            streamBandwithLogs:
              files
                .reduce((acc, file) => acc.concat(file.streamBandwithLogs), [])
                .sort((a, b) => a.timestamp - b.timestamp),
            magnet: doc.state.magnet,
            torrentFile: serializeTorrentFile(doc.state.torrentFile)
          },
          options: doc.options && {
            paused: doc.options.paused
          }
        })

        await context.dbDocument.incrementalUpdate({
          $set: {
            ...newDocument
          }
        })
      },
      assign(({ event }) => ({
        lastEvent: event
      }))
    ],
    guard: ({ context, event }) => context.lastEvent !== event
  }] as const,
  on: {
    'FILE.CHECKING': '.checkingFiles',
    'FILE.FINISHED': {
      guard: ({ context }) =>
        (context.files as ActorRefFrom<typeof torrentMachine>[])
          .every(file => file.getSnapshot().value === 'finished'),
      target: '.finished'
    },
    'TORRENT.PAUSE': {
      actions: assign({
        files: ({ context, event }) => {
          context.files.forEach(file => file.send({ type: 'FILE.PAUSE' }))
          return context.files
        }
      })
    },
    'TORRENT.RESUME': {
      actions: assign({
        files: ({ context, event }) => {
          context.files.forEach(file => file.send({ type: 'FILE.RESUME' }))
          return context.files
        }
      })
    },
    'TORRENT.REMOVE-AND-DELETE-FILES': {
      actions: [
        assign({
          shouldRemoveFiles: () => true
        })
      ],
      target: '.removing'
    },
    'TORRENT.REMOVE-AND-KEEP-FILES': {
      actions: [
        assign({
          shouldRemoveFiles: () => false
        })
      ],
      target: '.removing'
    }
  },
  states: {
    init: {
      invoke: {
        input: ({ context, event }) => ({ context, data: event }),
        src:
          fromPromise(async ({ input: _input }) => {
            const { context, data: { input } } = _input
            if (context.dbDocument) {
              return context.dbDocument
            }

            const document = await database.torrents.findOne(input.infoHash).exec()
            if (document) {
              return document
            }
            const torrentFileData =
              !input.torrentFile.infoBuffer
                ? (
                  await (torrentFile({ magnet: input.magnet })
                    .then(res => res.arrayBuffer())
                    .then(res => ParseTorrent(Buffer.from(res))))
                )
                : undefined

            const torrentDoc =
              serializeTorrentDocument({
                infoHash: input.infoHash,
                state: {
                  magnet:
                    input.magnet
                      ? input.magnet
                      : toMagnetURI(input.torrentFile!),
                  torrentFile:
                    input.torrentFile.infoBuffer
                      ? input.torrentFile
                      : torrentFileData
                }
              })


            return database.torrents.insert(torrentDoc)
          }),
        onDone: {
          target: 'checkingFiles',

          actions: [
            assign({
              document: ({ event }) => event.output.toJSON(),
              dbDocument: ({ event }) => event.output,
              files: ({ spawn, event, context }) =>
                event
                  .output
                  .state
                  .files
                  .filter(file => file.selected)
                  .map(file => {
                    return spawn(
                      fileMachine,
                      {
                        id: `torrent-${event.output.infoHash}-${file.path}`,
                        input: {
                          settingsDbDocument: context.settingsDbDocument,
                          document: event.output.toJSON(),
                          file
                        },
                        syncSnapshot: true
                      }
                    )
                  })
            })
          ]
        }
      }
    },
    checkingFiles: {
      invoke: {
        src: fromPromise(async () => {}),
        onDone: [
          {
            target: 'downloadingMetadata',
            guard: ({ context }) => !context.torrentFile,
          },
          {
            guard: or([
              ({ context }) => context.document.state.stats === 'finished',
              ({ context }) =>
                context.torrent &&
                (context.files as ActorRefFrom<typeof torrentMachine>[])
                  .every(file => file.getSnapshot().value === 'finished')
            ]),
            target: 'finished'
          },
          {
            target: 'downloading',
            guard: or([
              ({ context }) => context.document.state.status === 'downloading',
              ({ context }) => context.torrentFile
            ])
          }
        ]
      }
    },
    downloadingMetadata: {
      invoke: {
        input: ({ context }) => context,
        src: fromObservable((ctx) => {
          return ctx.input.document.$
        }),
        onSnapshot: {
          target: 'downloading',
          guard: ({ event }) => event.snapshot.context?.state?.torrentFile !== undefined
        }
      }
    },
    downloading: {
      invoke: {
        input: ({ context }) => context,
        src:
          fromObservable(({ input, ...rest }) => {
            return from([])
            // return (
            //   withLatestFrom(input.torrents.map(torrent => torrent.$))
            //     .pipe(
            //       mergeMap((settingsDocument) => settingsDocument?.$),
            //       filter((settingsDocument) => settingsDocument?.paused),
            //       first(),
            //     )
            // )
          }),
        // onDone: {
        //   target: 'paused'
        // }
      },
      on: {
        'FILES.FINISHED': 'finished',
        'TORRENT.PAUSE': {
          target: 'paused',
          actions: assign({
            files: ({ context, event }) => {
              context.files.forEach(file => file.send({ type: 'FILE.PAUSE' }))
              return context.files
            }
          })
        }
      }
    },
    paused: {
      on: {
        'TORRENT.RESUME': {
          target: 'downloading',
          actions: assign({
            files: ({ context, event }) => {
              context.files.forEach(file => file.send({ type: 'FILE.RESUME' }))
              return context.files
            }
          })
        }
      }
    },
    finished: {},
    removing: {
      invoke: {
        input: ({ context }) => ({ context }),
        src: fromPromise(async ({ input }) => {
          if (input.context.dbDocument) {
            await (await input.context.dbDocument.getLatest()).remove()
          }
          if (input.context.shouldRemoveFiles) {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('torrents')
            await directory.removeEntry(input.context.infoHash, { recursive: true })
          }
          return input.context.document
        }),
        onDone: {
          actions: [
            sendParent(({ context }) => ({
              type: 'TORRENT.REMOVED',
              input: {
                infoHash: context.infoHash,
              }
            }))
          ]
        }
      }
    }
  }
})

export type TorrentMachine = typeof torrentMachine
