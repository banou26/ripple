import { torrent, torrentFile } from '@fkn/lib'

export const getTorrentFile = ({ magnet }: { magnet: string }) =>
  torrentFile({ magnet })

export const getRemoteTorrentFileStream = async ({ magnet, path }: { magnet: string, path: string }) =>
  torrent({ magnet, path })
