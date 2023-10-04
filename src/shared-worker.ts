import WorkerURL from './shared-worker/index?worker&url'

const worker = new SharedWorker(WorkerURL, { type: 'module' })

worker.port.start()

worker.port.addEventListener('error', (err) => {
  console.error(err)
})

worker.port.addEventListener('message', (event) => {
  console.log('message', event.data)
})

console.log('loading worker', worker)

export default worker
