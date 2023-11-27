import type { ActorRefFrom } from 'xstate'

import { getTorrentProgress, type TorrentMachine } from './torrent'
import type { Resolvers } from '../worker'
import type { TorrentDocument } from '../database'

import { assign, createMachine, fromObservable, fromPromise } from 'xstate'
import { call } from 'osra'
import { Observable, filter, first, from, map, merge, partition, tap } from 'rxjs'
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
  on: {
    'FILE.PAUSE': {
      target: '.paused'
    },
    'FILE.RESUME': {
      target: '.downloading'
    }
  },
  invoke: {
    id: 'syncDBState',
    src: fromObservable(({ context, self, ...rest }) => {

      // self.subscribe((event) => {
      //   console.log('FILE EVENT', event)
      //   context.document.incrementalModify((doc) => {
      //     const file = doc.state.files.find((file) => file.path === context.file.path)
      //     if (!file) return doc
          
      //     return doc
      //   })
      // })

      const pause$ =
        from(self)
          .pipe(
            filter((event) => event.type === 'FILE.PAUSE'),
            tap(() => {
              context.document.incrementalModify((doc) => {
                const file = doc.state.files.find((file) => file.path === context.file.path)
                if (!file) return doc
                file.status = 'paused'
                return doc
              })
            })
          )

      const resume$ =
        from(self)
          .pipe(
            filter((event) => event.type === 'FILE.RESUME'),
            tap((event) => {
              context.document.incrementalModify((doc) => {
                const file = doc.state.files.find((file) => file.path === context.file.path)
                if (!file) return doc
                // file.status = 'downloading'
                return doc
              })
            })
          )

      return (
        merge(
          pause$,
          resume$
        )
      )
    })
  },
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
      invoke: {
        id: 'downloadFile',
        input: ({ context }) => context,
        src:
          fromObservable((ctx) =>
            new Observable(observer => {
              const document = ctx.input.document as RxDocument<TorrentDocument>
              console.log('downloadFile observable', ctx)
              
              if (ctx.input.file.selected === false) {
                return observer.complete()
              }

              const lastRange =
                ctx
                  .input
                  .file
                  .downloadedRanges
                  .sort((a, b) => a.start - b.start)
                  .at(0)

              const offsetStart = lastRange?.end || 0
              console.log('downloadFile offsetStart', offsetStart)


              console.log('AAAAAAAAAAAAAAAA', lastRange, ctx.input.file)
              if (offsetStart === ctx.input.file.length) {
                observer.complete()
                return
              }

              let cancelled = false
              let _close: () => void
              torrent({
                magnet: document.state.magnet,
                path: ctx.input.file.path,
                offset: offsetStart
              }).then(async (res: Response) => {
                const throttledResponse = throttleStream(res.body!, 10_000_000)
                const reader = throttledResponse.getReader() as ReadableStreamReader<Uint8Array>
                
                const { write, close } = await call<Resolvers>(getIoWorkerPort(), { key: 'io-worker' })(
                  'openWriteStream',
                  {
                    filePath: `torrents/${ctx.input.document.infoHash}/${ctx.input.file.path}`,
                    offset: offsetStart,
                    size: ctx.input.file.length
                  }
                )

                _close = close

                setInterval(() => {
                  console.log('doc', document.getLatest().state.files[0])
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
                  const bufferLength = value.byteLength
                  console.log('pull', value)
                  await write(value.buffer)
                  document.incrementalModify((doc) => {
                    const file = doc.state.files.find((file) => file.path === ctx.input.file.path)
                    if (!file) return doc
                    // get current downloadRange and update it, create one if it doesn't exist
                    const downloadRange =
                      file
                        .downloadedRanges
                        ?.find((range) => range.start <= offsetStart && range.end >= offsetStart)
                    if (downloadRange) {
                      downloadRange.end = downloadRange.end + bufferLength
                    } else {
                      file.downloadedRanges.push({
                        start: offsetStart,
                        end: offsetStart + bufferLength
                      })
                    }

                    console.log('downloadRange', file.downloadedRanges.at(-1))

                    // merge downloadedRanges
                    file.downloadedRanges = mergeRanges(file.downloadedRanges)
                    file.downloaded = file.downloadedRanges.reduce((acc, range) => acc + (range.end - range.start), 0)
                    doc.state.progress = getTorrentProgress(doc.state)
                    file.status = 'downloading'

                    return doc
                  })
                  if (!cancelled) read()
                }
                read()
              }).catch((err) => {
                console.log('downloadFile err', err)
                observer.error(err)
              })

              return () => {
                console.log('download file cancelled')
                cancelled = true
                _close()
              }
            })
          ),
        onDone: {
          target: 'finished'
        }
      },
      on: {
        'FILE.PAUSE': {
          target: 'paused',
          actions: assign({
            file: ({ context, event }) => {
              console.log('FILE downloading->FILE.PAUSE EVENT', event)
              // context.torrents.forEach(torrent => torrent.send({ type: 'TORRENT.PAUSE' }))
              return context.file
            }
          })
        }
      }
    },
    paused: {
      invoke: {
        id: 'pauseFile',
        input: ({ context }) => context,
        src:
          fromPromise(({ input }) =>
            input.document.incrementalModify((doc) => {
              doc.state.status = 'paused'
              return doc
            })
          )
      },
      on: {
        'FILE.RESUME': {
          target: 'downloading',
          actions: assign({
            file: ({ context, event }) => {
              console.log('FILE downloading->FILE.RESUME EVENT', event)
              // context.torrents.forEach(torrent => torrent.send({ type: 'TORRENT.RESUME' }))
              return context.file
            }
          })
        }
      }
    },
    finished: {
      invoke: {
        id: 'finishedFile',
        input: ({ context }) => context,
        src:
          fromPromise(async ({ input }) => {
            const document = input.document as RxDocument<TorrentDocument>
            console.log('TORRENT FILE FINISHED', input)
            await document.incrementalModify((doc) => {
              const file = doc.state.files.find((file) => file.path === input.file.path)
              if (!file) return doc
              file.downloaded = file.length
              file.progress = 1
              file.status = 'finished'
              doc.state.progress = getTorrentProgress(doc.state)
              return doc
            })
          })
      },
    }
  }
})

export type FileMachine = typeof fileMachine
