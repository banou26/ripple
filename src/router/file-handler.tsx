import { redirect } from 'react-router'

if ('launchQueue' in window) {
  window.launchQueue.setConsumer((launchParams) => {
    if (launchParams.files && launchParams.files.length) {
      console.log(launchParams.files[0].name)
    }
  })
}

const FileHandler = () => {
  redirect('/')
  return null
}

export default FileHandler
