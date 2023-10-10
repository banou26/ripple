import type { ActorRefFrom } from 'xstate'

import type { torrentManagerMachine } from './torrent-manager'
// import type { TorrentManagerMachine } from './torrent-manager'
import type { FileMachine } from './file'

import { createMachine, assign, fromObservable } from 'xstate'

import { TorrentDocument } from '../database'
import { fileMachine } from './file'

export const torrentMachine = createMachine({
  id: 'torrent',
  initial: 'downloadingMetadata',
  context: <T extends ActorRefFrom<typeof torrentManagerMachine>>({ input }: { input: { parent: T, document: TorrentDocument } }) => console.log('torrent context', input) || ({
    parent: input.parent as unknown as ActorRefFrom<typeof torrentManagerMachine>,
    document: input.document,
    files: [] as ActorRefFrom<typeof torrentMachine>[]
  }),
  on: {
    'FILE.CHECKING': '.checkingFiles',
    'FILE.FINISHED': {
      guard: ({ context }) =>
        (context.files as ActorRefFrom<typeof torrentMachine>[])
          .every(file => file.getSnapshot().value === 'ready'),
      target: '.finished'
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
        files: ({ spawn, context }) =>
          void console.log('context', context) ||
          context.document.state.files.map(file => {
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
      }),
      // after: {
      //   500: [
      //     {
      //       target: 'downloading',
      //       guard: ({ context }) =>
      //         context?.options.paused === false
      //     },
      //     {
      //       target: 'paused',
      //       guard: ({ context }) =>
      //         context?.options.paused === true
      //     }
      //   ]
      // }
    },
    downloading: {
      entry: () => console.log('downloading'),
      on: {
        'FILES.FINISHED': 'finished',
        'TORRENT.PAUSE': 'paused'
      }
    },
    paused: {
      on: {
        'TORRENT.RESUME': 'downloading'
      }
    },
    finished: {
      
    }
  }
})

export type TorrentMachine = typeof torrentMachine
