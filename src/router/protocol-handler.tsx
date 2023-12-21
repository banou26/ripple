import { redirect } from 'react-router'
import { useSearchParams } from 'react-router-dom'

const FileHandler = () => {
  const [params] = useSearchParams()
  const magnet = params.get('magnet')
  redirect('/')
  return null
}

export default FileHandler
