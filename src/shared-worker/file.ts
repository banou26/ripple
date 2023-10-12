import type { ActorRefFrom } from 'xstate'

import type { TorrentMachine } from './torrent'
import type { Resolvers } from '../worker'
import type { TorrentDocument } from '../database'

import { createMachine, fromObservable } from 'xstate'
import { call } from 'osra'
import { Observable, filter, first, map, tap } from 'rxjs'
import { torrent } from '@fkn/lib'

import { getIoWorkerPort } from './io-worker'
import { mergeRanges, throttleStream } from './utils'
import { RxDocument } from 'rxdb'

export const fileMachine = createMachine({
  id: 'torrentFile',
  initial: 'checkingFile',
  context: (
    { input }:
    { input: { parent: ActorRefFrom<TorrentMachine>, document: RxDocument<TorrentDocument>, file: NonNullable<RxDocument<TorrentDocument>['state']['files']>[number] } }
  ) => ({
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
              const document = ctx.input.document as RxDocument<TorrentDocument>
              console.log('downloadFile observable', ctx)
              
              const offsetStart =
                ctx
                  .input
                  .file
                  .downloadedRanges
                  .sort((a, b) => a.start - b.start)
                  .at(0)?.end || 0
              console.log('downloadFile offsetStart', offsetStart)

              let cancelled = false
              torrent({
                magnet: document.state.magnet,
                path: ctx.input.file.path,
                offset: offsetStart
              }).then(async (res: Response) => {
                const throttledResponse = throttleStream(res.body!, 1_000_000)
                const reader = throttledResponse.getReader() as ReadableStreamReader<Uint8Array>
                
                const { write, close } = await call<Resolvers>(getIoWorkerPort(), { key: 'io-worker' })(
                  'openWriteStream',
                  {
                    filePath: `torrents/${ctx.input.document.infoHash}/${ctx.input.file.path}`,
                    offset: offsetStart,
                    size: ctx.input.file.length
                  }
                )

                setInterval(() => {
                  console.log('doc', document.getLatest().state.files[0]?.downloadedRanges)
                }, 1000)

                const read = async () => {
                  if (cancelled) {
                    await reader.cancel()
                    await close()
                    return
                  }
                  const { done, value } = await reader.read()
                  if (done) {
                    await close()
                    observer.complete()
                    return
                  }
                  console.log('pull', value)
                  // await write(value)
                  // document.incrementalModify((doc) => {
                  //   const file = doc.state.files.find((file) => file.path === ctx.input.file.path)
                  //   if (!file) return doc
                  //   // get current downloadRange and update it, create one if it doesn't exist
                  //   const downloadRange =
                  //     file
                  //       .downloadedRanges
                  //       ?.find((range) => range.start <= offsetStart && range.end >= offsetStart)
                  //   if (downloadRange) {
                  //     downloadRange.end = downloadRange.end + value.byteLength
                  //   } else {
                  //     file.downloadedRanges.push({
                  //       start: offsetStart,
                  //       end: offsetStart + value.byteLength
                  //     })
                  //   }

                  //   // merge downloadedRanges
                  //   file.downloadedRanges = mergeRanges(file.downloadedRanges)

                  //   return doc
                  // })
                  if (!cancelled) read()
                }
                // read()
              }).catch((err) => {
                console.log('downloadFile err', err)
                observer.error(err)
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

