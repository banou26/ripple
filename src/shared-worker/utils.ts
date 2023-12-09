export const fetchWithThrottle = async (url: string, maxdownloadSpeed: number) => {
  const response = await fetch(url)
  if (!response.body) throw new Error('no body')
  const reader = response.body.getReader()
  const controller = new AbortController()

  const stream = new ReadableStream({
    async start(controller) {
      while (true) {
        const startTime = Date.now()
        const { done, value } = await reader.read()

        if (done) {
          controller.close()
          return
        }

        controller.enqueue(value)

        const endTime = Date.now()
        const duration = endTime - startTime
        const bytesRead = value.length

        // Calculate how much time to wait in order to maintain the desired bandwidth
        const waitTime = (bytesRead / maxdownloadSpeed * 1000) - duration
        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime))
        }
      }
    },
    cancel() {
      controller.abort()
    }
  })

  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  })
}

// export const throttleStream = (stream: ReadableStream<Uint8Array>, maxdownloadSpeed: number) => {
//   const reader = stream.getReader()
//   const controller = new AbortController()
//   return new ReadableStream({
//     async start(controller) {
//       while (true) {
//         const startTime = Date.now()
//         const { done, value } = await reader.read()

//         if (done) {
//           controller.close()
//           return
//         }

//         controller.enqueue(value)

//         const endTime = Date.now()
//         const duration = endTime - startTime
//         const bytesRead = value.length

//         // Calculate how much time to wait in order to maintain the desired bandwidth
//         const waitTime = (bytesRead / maxdownloadSpeed * 1000) - duration
//         if (waitTime > 0) {
//           await new Promise(resolve => setTimeout(resolve, waitTime))
//         }
//       }
//     },
//     cancel() {
//       controller.abort()
//     }
//   })
// }

export const throttleStream = (stream: ReadableStream<Uint8Array>, getMaxDownloadSpeed: () => number) =>
  new ReadableStream<Uint8Array>({
    start() {
      this.reader = stream.getReader()
    },
    async pull(controller) {
      const startTime = Date.now()
      const { done, value } = await (this.reader as ReadableStreamDefaultReader<Uint8Array>).read()

      if (done) {
        controller.close()
        return
      }

      controller.enqueue(value)

      const endTime = Date.now()
      const duration = endTime - startTime
      const bytesRead = value.length

      // Calculate how much time to wait in order to maintain the desired bandwidth
      const waitTime = (bytesRead / (getMaxDownloadSpeed() ?? Number.MAX_VALUE) * 1000) - duration
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
    },
    cancel() {
      this.reader?.cancel()
    }
  })

type Range = {
  start: number
  end: number
}

export const mergeRanges = (ranges: Range[]): Range[] => {
  if (ranges.length === 0) return []

  // Sort the ranges by the start value
  const sortedRanges = ranges.sort((a, b) => a.start - b.start)

  const mergedRanges: Range[] = [sortedRanges[0]]

  for (let i = 1; i < sortedRanges.length; i++) {
      const current = sortedRanges[i]
      const lastMerged = mergedRanges[mergedRanges.length - 1]

      if (current.start <= lastMerged.end + 1) {
          // If the current range overlaps with the last merged range, merge them
          lastMerged.end = Math.max(lastMerged.end, current.end)
      } else {
          // Otherwise, push the current range to the merged list
          mergedRanges.push(current)
      }
  }

  return mergedRanges
}
