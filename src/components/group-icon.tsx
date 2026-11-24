import type { ComponentType } from 'react'

import { css } from '@emotion/react'
import {
  Archive, BookOpen, Code2, Film, Folder, Gamepad2, Globe, Heart, Image, Music, Star, Tv,
} from 'lucide-react'
import { useIntl } from 'react-intl'

import type { GroupIcon, PresetIconId } from '../torrent/group-appearance'

import { groupImageKey, useGroupPreviewThumbnails } from '../torrent/group-appearance'
import { useThumbnail } from '../torrent/use-thumbnails'
import { BORDER, BORDER_INTERACTIVE, CONTROL_BG, GROUP_TEXT, SUNKEN_BG } from '../theme'

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

const groupPosterStyle = css`
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  width: 150px;
  min-height: 84px;
  box-sizing: border-box;
  padding-top: 7px;

  /* Overlaps .folder-body by 1px so the tab and folder frame read as one unbroken container. */
  .folder-tab {
    position: absolute;
    top: 0;
    inset-inline-start: 0;
    width: 44%;
    height: 8px;
    z-index: 1;
    box-sizing: border-box;
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER_INTERACTIVE};
    border-bottom: none;
    border-start-start-radius: 6px;
    border-start-end-radius: 6px;
  }

  .folder-body {
    position: relative;
    flex: 1;
    min-height: 0;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER_INTERACTIVE};
    border-start-start-radius: 0;
    border-start-end-radius: 7px;
    border-end-start-radius: 7px;
    border-end-end-radius: 7px;
    display: grid;
    place-items: center;
    color: ${GROUP_TEXT};

    svg { flex: none; }
  }

  /* Absolute inset decouples intrinsic thumbnail dimensions from the card row height. */
  .folder-cover {
    position: absolute;
    inset: 0;
    padding: 4px;
    box-sizing: border-box;

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 4px;
      min-width: 0;
      min-height: 0;
    }
  }

  .folder-grid {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    gap: 4px;
    padding: 5px;
    box-sizing: border-box;

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 3px;
      min-width: 0;
      min-height: 0;
    }

    .slot {
      background: ${SUNKEN_BG};
      border: 1px solid ${BORDER};
      border-radius: 3px;
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
    }
  }
`

/** Renders a group row's poster inside a tabbed folder frame: custom image, preset icon, 2x2 thumbnail grid (for 1 to 4 thumbnails), or a Folder fallback. */
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

  let body
  if (icon.kind === 'image' && customUrl) {
    body = (
      <div className="folder-cover">
        <img src={customUrl} alt="" loading="lazy"/>
      </div>
    )
  } else if (icon.kind === 'preset') {
    const Icon = PRESET_ICON_COMPONENTS[icon.icon]
    body = <Icon size={24} strokeWidth={1.75} aria-hidden/>
  } else if (collageUrls.length >= 1) {
    body = (
      <div className="folder-grid">
        {[0, 1, 2, 3].map((slot) => (
          collageUrls[slot]
            ? <img key={slot} src={collageUrls[slot]} alt="" loading="lazy"/>
            : <div key={slot} className="slot"/>
        ))}
      </div>
    )
  } else {
    body = <Folder size={24} strokeWidth={1.75} aria-hidden/>
  }

  return (
    <div css={groupPosterStyle} className="poster group-poster" aria-hidden="true">
      <span className="folder-tab"/>
      <div className="folder-body">{body}</div>
    </div>
  )
}

const EMPTY_HASHES: readonly string[] = []

const miniIconStyle = css`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border-radius: 4px;
  overflow: hidden;
  color: ${GROUP_TEXT};

  svg { flex: none; }

  &.framed {
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER_INTERACTIVE};
  }

  &.cover {
    background: ${CONTROL_BG};
    border: 1px solid ${BORDER_INTERACTIVE};
    padding: 1px;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 2px;
      display: block;
    }
  }
`

const miniGridStyle = css`
  display: inline-grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1px;
  padding: 2px;
  background: ${CONTROL_BG};
  border: 1px solid ${BORDER_INTERACTIVE};

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 1px;
    display: block;
    min-width: 0;
    min-height: 0;
  }

  .slot {
    display: block;
    width: 100%;
    height: 100%;
    background: ${SUNKEN_BG};
    border-radius: 1px;
    min-width: 0;
    min-height: 0;
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
    return <span css={miniIconStyle} className="cover" aria-hidden="true"><img src={customUrl} alt=""/></span>
  }
  if (icon.kind === 'preset') {
    const Icon = PRESET_ICON_COMPONENTS[icon.icon]
    return <span css={miniIconStyle} className="framed" aria-hidden="true"><Icon size={13} strokeWidth={1.9} aria-hidden/></span>
  }
  if (collageUrls.length >= 1) {
    return (
      <span css={[miniIconStyle, miniGridStyle]} aria-hidden="true">
        {[0, 1, 2, 3].map((slot) => (
          collageUrls[slot]
            ? <img key={slot} src={collageUrls[slot]} alt=""/>
            : <span key={slot} className="slot"/>
        ))}
      </span>
    )
  }
  return <span css={miniIconStyle} aria-hidden="true"><Folder size={15} strokeWidth={1.9} aria-hidden/></span>
}
