import type { ComponentType } from 'react'

import { css } from '@emotion/react'
import {
  Archive, BookOpen, Code2, Film, Folder, Gamepad2, Globe, Heart, Image, Music, Star, Tv,
} from 'lucide-react'
import { useIntl } from 'react-intl'

import type { GroupIcon, PresetIconId } from '../torrent/group-appearance'

import { groupImageKey, useGroupPreviewThumbnails } from '../torrent/group-appearance'
import { useThumbnail } from '../torrent/use-thumbnails'
import { BORDER, CONTROL_BG, SUNKEN_BG, TEXT_MUTED } from '../theme'

export const PRESET_ICON_COMPONENTS: Record<PresetIconId, ComponentType<{ size?: number, strokeWidth?: number, 'aria-hidden'?: boolean }>> = {
  folder: Folder,
  film: Film,
  tv: Tv,
  music: Music,
  gamepad: Gamepad2,
  book: BookOpen,
  image: Image,
  archive: Archive,
  code: Code2,
  star: Star,
  heart: Heart,
  globe: Globe,
}

export const presetIconLabel = (icon: PresetIconId, intl: ReturnType<typeof useIntl>): string => {
  switch (icon) {
    case 'folder': return intl.formatMessage({ id: 'Folder icon', defaultMessage: 'Folder icon' })
    case 'film': return intl.formatMessage({ id: 'Film icon', defaultMessage: 'Film icon' })
    case 'tv': return intl.formatMessage({ id: 'TV icon', defaultMessage: 'TV icon' })
    case 'music': return intl.formatMessage({ id: 'Music icon', defaultMessage: 'Music icon' })
    case 'gamepad': return intl.formatMessage({ id: 'Games icon', defaultMessage: 'Games icon' })
    case 'book': return intl.formatMessage({ id: 'Books icon', defaultMessage: 'Books icon' })
    case 'image': return intl.formatMessage({ id: 'Images icon', defaultMessage: 'Images icon' })
    case 'archive': return intl.formatMessage({ id: 'Archive icon', defaultMessage: 'Archive icon' })
    case 'code': return intl.formatMessage({ id: 'Code icon', defaultMessage: 'Code icon' })
    case 'star': return intl.formatMessage({ id: 'Favorites icon', defaultMessage: 'Favorites icon' })
    case 'heart': return intl.formatMessage({ id: 'Saved icon', defaultMessage: 'Saved icon' })
    case 'globe': return intl.formatMessage({ id: 'Web icon', defaultMessage: 'Web icon' })
  }
}

const collageStyle = css`
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 1px;
  padding: 0;
  overflow: hidden;
  background: ${BORDER};

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .slot {
    background: ${SUNKEN_BG};
    min-width: 0;
    min-height: 0;
  }
`

const presetPosterStyle = css`
  display: grid;
  place-items: center;
  background: ${CONTROL_BG};
  color: ${TEXT_MUTED};
`

/**
 * Renders a group row's poster: custom uploaded image, chosen preset icon, a 2x2 collage of up to four
 * member torrent thumbnails, or a Folder fallback when no preview image exists yet.
 */
export const GroupPoster = ({
  groupId,
  icon,
  previewHashes,
}: {
  groupId: string
  icon: GroupIcon
  previewHashes: readonly string[]
}) => {
  const customUrl = useThumbnail(icon.kind === 'image' ? groupImageKey(groupId, icon.hash) : undefined)
  const collageUrls = useGroupPreviewThumbnails(icon.kind === 'default' ? previewHashes : EMPTY_HASHES)

  if (icon.kind === 'image' && customUrl) {
    return <img className="poster" src={customUrl} alt="" loading="lazy"/>
  }

  if (icon.kind === 'preset') {
    const Icon = PRESET_ICON_COMPONENTS[icon.icon]
    return (
      <div css={presetPosterStyle} className="poster placeholder" aria-hidden="true">
        <Icon size={22} strokeWidth={1.75} aria-hidden/>
      </div>
    )
  }

  if (collageUrls.length === 1) {
    return <img className="poster" src={collageUrls[0]} alt="" loading="lazy"/>
  }

  if (collageUrls.length >= 2) {
    return (
      <div css={collageStyle} className="poster" aria-hidden="true">
        {[0, 1, 2, 3].map((slot) => (
          collageUrls[slot]
            ? <img key={slot} src={collageUrls[slot]} alt="" loading="lazy"/>
            : <div key={slot} className="slot"/>
        ))}
      </div>
    )
  }

  return (
    <div css={presetPosterStyle} className="poster placeholder" aria-hidden="true">
      <Folder size={22} strokeWidth={1.75} aria-hidden/>
    </div>
  )
}

const EMPTY_HASHES: readonly string[] = []

const miniIconStyle = css`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  overflow: hidden;
  color: ${TEXT_MUTED};

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
`

/** Compact inline icon for table group rows. */
export const GroupMiniIcon = ({
  groupId,
  icon,
  previewHashes,
}: {
  groupId: string
  icon: GroupIcon
  previewHashes: readonly string[]
}) => {
  const customUrl = useThumbnail(icon.kind === 'image' ? groupImageKey(groupId, icon.hash) : undefined)
  const collageUrls = useGroupPreviewThumbnails(icon.kind === 'default' ? previewHashes : EMPTY_HASHES)

  if (icon.kind === 'image' && customUrl) {
    return <span css={miniIconStyle} aria-hidden="true"><img src={customUrl} alt=""/></span>
  }
  if (icon.kind === 'preset') {
    const Icon = PRESET_ICON_COMPONENTS[icon.icon]
    return <span css={miniIconStyle} aria-hidden="true"><Icon size={14} strokeWidth={1.85} aria-hidden/></span>
  }
  if (collageUrls.length > 0) {
    return <span css={miniIconStyle} aria-hidden="true"><img src={collageUrls[0]} alt=""/></span>
  }
  return <span css={miniIconStyle} aria-hidden="true"><Folder size={14} strokeWidth={1.85} aria-hidden/></span>
}
