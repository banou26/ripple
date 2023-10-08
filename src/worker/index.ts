
console.log('IO worker')

globalThis.addEventListener('message', (ev) => {
  console.log('ev', ev)
})
