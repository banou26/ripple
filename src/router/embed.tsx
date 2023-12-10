import { addTorrent, torrentCollection, type TorrentDocument } from '../database'

import { useEffect, useMemo, useState } from 'react'
import { css } from '@emotion/react'
import { redirect, useNavigate, useParams } from 'react-router'
import { useSearchParams } from 'react-router-dom'
import { useRxCollection, useRxQuery } from 'rxdb-hooks'
import ParseTorrent from 'parse-torrent'

import { getRoutePath, Route } from './path'
import { playableVideoFileExtensions } from '../utils/file-type'

const style = css`
height: 100%;
width: 100%;

display: flex;
align-items: center;
justify-content: center;

font-size: 3rem;
font-weight: bold;
`

const Embed = () => {
  const [searchParams] = useSearchParams()
  const { magnet: _magnet, torrentFile } = Object.fromEntries(searchParams.entries())
  const magnet = useMemo(() => _magnet && atob(_magnet), [_magnet])
  const navigate = useNavigate()

  const [torrentInstance, setTorrentInstance] = useState<ParseTorrent.Instance>()
  useEffect(() => {
    if (!magnet) return
    ParseTorrent(magnet)
      .then(res => setTorrentInstance(res))
  }, [magnet])

  const collection = useRxCollection<TorrentDocument>('torrents')
  console.log('collection', collection)
  const torrentDocQuery = collection?.findOne({ selector: { infoHash: torrentInstance?.infoHash } })
  console.log('torrentDocQuery', torrentDocQuery)
  const { result: [torrentDoc], isFetching } = useRxQuery(torrentDocQuery)
  console.log('torrentDoc', torrentDoc)

  useEffect(() => {
    console.log('aaa', !magnet, !torrentInstance, isFetching, torrentDoc)
    if (!magnet || !torrentInstance || isFetching || torrentDoc) return
    setTimeout(() => {
      console.log('addTorrent', {
        magnet,
        torrentFile: torrentInstance
      })
      addTorrent({ magnet })
    }, 1_000)
  }, [magnet, isFetching, torrentInstance, torrentDoc])
  // const file = torrentDoc?.state?.files?.[fileIndex]

  useEffect(() => {
    if (!torrentInstance || !torrentCollection || !navigate) return

    const tryWithDocument = async () => {
      const torrentDocs = await torrentCollection?.find({}).exec()
      const torrentDoc = torrentDocs.find(doc => doc.infoHash === torrentInstance.infoHash)
      console.log('tryWithDocument', torrentDocs)
      if (!torrentDoc) return
      const playableFiles = torrentDoc.state.files?.filter((file) => playableVideoFileExtensions.includes(file.name.split('.').pop() ?? ''))
      const playableFile = playableFiles?.[0]
      clearInterval(interval)
      setTimeout(() => {
        navigate(getRoutePath(Route.WATCH, { infoHash: torrentDoc.infoHash, fileIndex: playableFile?.index }))
      }, 1000)
    }
    const interval = setInterval(tryWithDocument, 200)
    tryWithDocument()

    return () => clearInterval(interval)
  }, [torrentCollection, navigate, torrentInstance])

  return (
    <div css={style}>
      <div>Fetching torrent metadata</div>
    </div>
  )
}

export default Embed
