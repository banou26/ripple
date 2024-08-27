import { Readable } from 'stream'

export const nodeToWebReadable = (stream: Readable | NodeJS.ReadableStream) => {
  const iterator = stream[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel() {
      if ('destroy' in stream) stream.destroy()
      iterator.return?.()
    }
  })
}
