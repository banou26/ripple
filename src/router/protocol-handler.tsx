import { redirect } from 'react-router'
import { useSearch } from 'wouter/use-location'

const FileHandler = () => {
  const searchParams = new URLSearchParams(useSearch())
  const magnet = params.get('magnet')
  redirect('/')
  return null
}

export default FileHandler
