import type { ActorRefFrom } from 'xstate'

import type { TorrentMachine } from './torrent'

import { createMachine, fromObservable, fromPromise } from 'xstate'

import { TorrentDocument } from '../database'
import { EMPTY, concat, filter, first, map, tap } from 'rxjs'



export const fileMachine = createMachine({
  id: 'torrentFile',
  initial: 'checkingFile',
  context: <T extends ActorRefFrom<TorrentMachine>>({ input }: { input: { parent: T, document: TorrentDocument, file: TorrentDocument['state']['files'][number] } }) => console.log('File input', input) || ({
    parent: input.parent as unknown as ActorRefFrom<TorrentMachine>,
    document: input.document,
    file: input.file
  }),
  states: {
    checkingFile: {
      invoke: {
        id: 'checkFile',
        input: ({ context }) => context,
        src:
          fromObservable((ctx) => {
            console.log('checkFile context', ctx)
            return (
              ctx
                .input
                .document
                .get$(`state`)
                .pipe(
                  map((state) => state.files.find((file, index) => index === ctx.input.file.index)),
                  filter((file) => file !== undefined),
                  first(),
                  tap((v) => console.log('tap', v))
                )
            )
          }),
        onSnapshot: {
          target: 'downloading',
          guard: ({ event }) => console.log('File checkingFile onSnapshot', event) || event.snapshot.context?.selected === true
        }
      }
    },
    downloading: {
      entry: (ctx) => console.log('File downloading entry', ctx),
      // on: {
      //   'FILES.FINISHED': 'finished',
      //   'TORRENT.PAUSE': 'paused'
      // }
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

export type FileMachine = typeof fileMachine

