import { File as FileIcon, FilePlay, Folder } from 'lucide-react'

import { glyphFor } from '../torrent/thumbnail'

const ICON = { video: FilePlay, file: FileIcon, folder: Folder }

/**
 * The icon, and the extension under it, drawn where a torrent's picture goes while it has none.
 *
 * Decorative like the picture it stands in for, since the name beside it already ends in the same
 * extension. The library row and the download page style it themselves; the label is `.ext`.
 */
export const FileGlyph = ({ name, files }: { name: string, files?: readonly { name: string, pad?: boolean }[] }) => {
  const { kind, ext } = glyphFor(name, files)
  const Icon = ICON[kind]
  return (
    <>
      <Icon/>
      {ext && <span className="ext" aria-hidden="true">{ext}</span>}
    </>
  )
}
