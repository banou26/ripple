import type { ActorRefFrom } from 'xstate'

import type { torrentManagerMachine } from './torrent-manager'

import { createMachine, assign, fromObservable } from 'xstate'

import { TorrentDocument } from '../database'
import { fileMachine } from './file'
import { from, withLatestFrom } from 'rxjs'

export const getTorrentProgress = (torrentState: TorrentDocument['state']) => {
  const selectedFiles = torrentState.files?.filter(file => file.selected) ?? []
  const totalLength = selectedFiles.reduce((acc, file) => acc + file.length, 0)
  const downloadedLength = selectedFiles.reduce((acc, file) => acc + file.downloaded, 0)
  return downloadedLength / totalLength
}

export const getTorrentStatus = () => {

}

export const torrentMachine = createMachine({
  id: 'torrent',
  initial: 'downloadingMetadata',
  context: <T extends ActorRefFrom<typeof torrentManagerMachine>>({ input }: { input: { parent: T, document: TorrentDocument } }) => console.log('torrent context', input) || ({
    parent: input.parent as unknown as ActorRefFrom<typeof torrentManagerMachine>,
    document: input.document,
    files: [] as ActorRefFrom<typeof torrentMachine>[]
  }),
  // invoke: {
  //   id: 'getTorrentMetadata',
  //   src: fromObservable(({ context, self }) => {

  //     return context.document.$.pipe(

  //     )
  //   })
  // },
  on: {
    'FILE.CHECKING': '.checkingFiles',
    'FILE.FINISHED': {
      guard: ({ context }) =>
        (context.files as ActorRefFrom<typeof torrentMachine>[])
          .every(file => file.getSnapshot().value === 'ready'),
      target: '.finished'
    },
    'TORRENT.PAUSE': {
      actions: assign({
        files: ({ context, event }) => {
          console.log('TORRENT# on PAUSE EVENT', event)
          context.files.forEach(file => file.send({ type: 'FILE.PAUSE' }))
          return context.files
        }
      })
    },
    'TORRENT.RESUME': {
      actions: assign({
        files: ({ context, event }) => {
          console.log('TORRENT# on RESUME EVENT', event)
          context.files.forEach(file => file.send({ type: 'FILE.RESUME' }))
          return context.files
        }
      })
    }
  },
  states: {
    downloadingMetadata: {
      invoke: {
        id: 'getTorrentMetadata',
        input: ({ context }) => context,
        src: fromObservable((ctx) => {
          console.log('document', ctx.input.document)
          return ctx.input.document.$
        }),
        onSnapshot: {
          target: 'checkingFiles',
          guard: ({ event }) => event.snapshot.context?.state?.torrentFile !== undefined
        }
      }
    },
    checkingFiles: {
      entry: assign({
        files: ({ spawn, context }) => {
          context.files.forEach(file => file.stop())
          return context.document.state.files.map(file => {
            return spawn(
              fileMachine,
              {
                id: `torrent-${context.document.infoHash}-${file.path}`,
                input: {
                  parent: context.parent,
                  document: context.document,
                  file
                }
              }
            )
          })
        }
      }),
      invoke: {
        id: 'checking files status watch',
        input: ({ context }) => context,
        src:
          fromObservable(({ input, ...rest }) => {
            console.log('TORRENT CHECKINGFILES', input, rest)

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
    },
    downloading: {
      entry: () => console.log('downloading'),
      invoke: {
        id: 'downloading status watch',
        input: ({ context }) => context,
        src:
          fromObservable(({ input, ...rest }) => {
            console.log('TORRENT DOWNLOADING', input, rest)

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
              console.log('TORRENT# downloading->TORRENT.PAUSE EVENT', event)
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
              console.log('TORRENT# paused->TORRENT.RESUME EVENT', event)
              context.files.forEach(file => file.send({ type: 'FILE.RESUME' }))
              return context.files
            }
          })
        }
      }
    },
    finished: {
      entry: () => console.log('finished'),
      invoke: {
        id: 'finished status watch',
        input: ({ context }) => context,
        src:
          fromObservable(({ input, ...rest }) => {
            console.log('TORRENT FINISHED', input, rest)

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
    }
  }
})

export type TorrentMachine = typeof torrentMachine
