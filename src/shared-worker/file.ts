import type { ActorRefFrom } from 'xstate'

import type { TorrentMachine } from './torrent'
import type { Resolvers } from '../worker'
import type { TorrentDocument } from '../database'

import { createMachine, fromObservable } from 'xstate'
import { call } from 'osra'
import { Observable, filter, first, map, tap } from 'rxjs'
import { torrent } from '@fkn/lib'

import { getIoWorkerPort } from './io-worker'
import { throttleStream } from './utils'
import { RxDocument } from 'rxdb'

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
              const document = ctx.input.document as RxDocument<TorrentDocument>
              console.log('downloadFile observable', ctx)
              
              const offsetStart = ctx.input.file.downloadedRanges?.reduce((acc, range) => {
                if (range.end > acc) return range.end
                return acc
              }, 0) || 0

              let cancelled = false
              torrent({
                magnet: document.state.magnet,
                path: ctx.input.file.path
              }).then(async (res: Response) => {
                console.log('downloadFile res', res)
                const throttledResponse = throttleStream(res.body!, 1_000_000)
                console.log('downloadFile throttledResponse', throttledResponse)
                const reader = throttledResponse.getReader()
                
                // const { write, close } = await call<Resolvers>(getIoWorkerPort(), { key: 'io-worker' })(
                //   'openWriteStream',
                //   {
                //     filePath: `torrents/${ctx.input.document.infoHash}/${ctx.input.file.path}`,
                //     offset: 0,
                //     size: ctx.input.file.length
                //   }
                // )

                // offsetStart depending on already downloaded ranges

                // const offsetStart = ctx.input.file.offset

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
                  // await write(value)
                  document.incrementalModify((doc) => {
                    const file = doc.state.files.find((file) => file.index === ctx.input.file.index)
                    if (!file) return doc
                    file.downloaded += value.length
                    file.progress = file.downloaded / file.length
                    // get current downloadRange and update it, create one if it doesn't exist
                    const downloadRange = file.downloadedRanges?.find((range) => range.start <= offsetStart && range.end >= offsetStart + value.length)
                    if (downloadRange) {
                      downloadRange.end = downloadRange.end + value.length
                    } else {
                      file.downloadedRanges.push({
                        start: offsetStart,
                        end: value.length
                      })
                    }

                    // merge downloadedRanges if they are adjacent
                    file.downloadedRanges = file.downloadedRanges.reduce((acc, range) => {
                      const lastRange = acc[acc.length - 1]
                      if (lastRange && lastRange.end === range.start) {
                        lastRange.end = range.end
                      } else {
                        acc.push(range)
                      }
                      return acc
                    }, [] as { start: number, end: number }[])

                    return doc
                  })
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

