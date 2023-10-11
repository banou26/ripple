import type { ActorRefFrom } from 'xstate'

import type { TorrentMachine } from './torrent'
import type { Resolvers } from '../worker'
import type { TorrentDocument } from '../database'

import { createMachine, fromObservable } from 'xstate'
import { call } from 'osra'
import { Observable, filter, first, map, tap } from 'rxjs'
import { torrent } from '@fkn/lib'

import { getIoWorkerPort } from './io-worker'

export const fileMachine = createMachine({
  id: 'torrentFile',
  initial: 'checkingFile',
  context: <T extends ActorRefFrom<TorrentMachine>>(
    { input }:
    { input: { parent: T, document: TorrentDocument, file: NonNullable<TorrentDocument['state']['files']>[number] } }
  ) =>
  console.log('File input', input) || ({
    parent: input.parent as unknown as ActorRefFrom<TorrentMachine>,
    document: input.document,
    file: input.file as NonNullable<TorrentDocument['state']['files']>[number]
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
      invoke: {
        id: 'downloadFile',
        input: ({ context }) => context,
        src:
          fromObservable((ctx) =>
            new Observable(observer => {
              console.log('downloadFile observable', ctx)
              
              let cancelled = false
              torrent({
                magnet: ctx.input.document.state.magnet,
                path: ctx.input.file.path
              }).then(async (res: Response) => {
                console.log('downloadFile res', res)
                const reader = res.body?.getReader()!
                
                const { write, close } = await call<Resolvers>(getIoWorkerPort(), { key: 'io-worker' })(
                  'openWriteStream',
                  {
                    filePath: `torrents/${ctx.input.document.infoHash}/${ctx.input.file.path}`,
                    offset: 0,
                    size: ctx.input.file.length
                  }
                )


                const read = () =>
                  reader
                    .read()
                    .then(async ({ done, value }) => {
                      if (cancelled) {
                        await reader.cancel()
                        await close()
                        return
                      }
                      if (done) {
                        return await close()
                      }
                      await write(value.buffer)
                      read()
                    })
                read()
              })


              return () => {
                cancelled = true
              }
            })
          ),
        onDone: {
          target: 'finished'
        }
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

export type FileMachine = typeof fileMachine

