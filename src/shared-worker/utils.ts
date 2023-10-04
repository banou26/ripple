export const fetchWithThrottle = async (url: string, maxBytesPerSecond: number) => {
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
        const waitTime = (bytesRead / maxBytesPerSecond * 1000) - duration
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
