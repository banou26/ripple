import type { TorrentGroup } from '../../src/torrent/groups'
import type { Torrent } from '../../src/torrent/types'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { del } from 'idb-keyval'

import { GroupNameDialog } from '../../src/components/group-dialogs'
import { GroupPoster } from '../../src/components/group-icon'
import { IntlRoot } from '../../src/i18n'
import { TorrentTable } from '../../src/router/torrent-table'
import {
  DEFAULT_ICON, GROUP_APPEARANCE_KEY, clearGroupAppearance, groupImageKey, saveGroupImage, setGroupIcon,
} from '../../src/torrent/group-appearance'
import { summarizeGroup } from '../../src/torrent/group-rows'
import { EMPTY_LIST_ORDER, LIST_ORDER_KEY, saveGroupMemberOrder, saveTopOrder } from '../../src/torrent/list-order'
import { loadCachedThumbnails, saveCustomThumbnail } from '../../src/torrent/thumbnail-store'

const hash = (c: string) => c.repeat(40)

// Minimal valid 2x2 PNG bytes for real canvas decode + WebP shrink in Chromium.
const PNG_2X2 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d,
  0x24, 0x00, 0x00, 0x00, 0x14, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x04, 0x18, 0x03, 0x19, 0x80, 0x88, 0x01, 0x00, 0x4e, 0xfd, 0x07, 0xfd, 0x16, 0x1c, 0xa8,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const mkTorrent = (c: string, over: Partial<Torrent> = {}): Torrent => ({
  id: c,
  infoHash: hash(c),
  magnet: `magnet:?xt=urn:btih:${hash(c)}`,
  name: `Release ${c}`,
  size: 2_000,
  downloaded: 2_000,
  progress: 1,
  state: 'completed',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: null,
  addedAt: 100,
  ...over,
})

const mkGroup = (id: string, name: string, members: string[]): TorrentGroup => ({
  id,
  name,
  namedAt: 100,
  members: members.map((infoHash) => ({ infoHash, at: 100 })),
})

beforeEach(async () => {
  await del(GROUP_APPEARANCE_KEY)
  await del(LIST_ORDER_KEY)
})
afterAll(async () => {
  await del(GROUP_APPEARANCE_KEY)
  await del(LIST_ORDER_KEY)
})

describe('group poster and icons', () => {
  it('always wraps group posters in a folder silhouette, including a 1-torrent group with a thumbnail', async () => {
    const empty = await render(<IntlRoot><GroupPoster groupId="g1" icon={DEFAULT_ICON} previewHashes={[]}/></IntlRoot>)
    expect(empty.container.querySelector('.group-poster .folder-tab')).not.toBeNull()
    expect(empty.container.querySelector('.group-poster .folder-body svg.lucide-folder')).not.toBeNull()
    await empty.unmount()

    const preset = await render(<IntlRoot><GroupPoster groupId="g1" icon={{ kind: 'preset', icon: 'film' }} previewHashes={[]}/></IntlRoot>)
    expect(preset.container.querySelector('.group-poster .folder-tab')).not.toBeNull()
    expect(preset.container.querySelector('.group-poster .folder-body svg.lucide-film')).not.toBeNull()
    await preset.unmount()

    const pngBlob = new Blob([PNG_2X2], { type: 'image/png' })
    const hashes = ['a', 'b', 'c', 'd'].map(hash)
    for (const h of hashes) await saveCustomThumbnail(h, pngBlob)
    await loadCachedThumbnails(hashes)

    const single = await render(<IntlRoot><GroupPoster groupId="g1" icon={DEFAULT_ICON} previewHashes={[hashes[0]!]}/></IntlRoot>)
    await expect.poll(() => single.container.querySelectorAll('.group-poster .folder-grid img').length).toBe(1)
    const tab = single.container.querySelector('.group-poster .folder-tab')!
    expect(tab).not.toBeNull()
    expect(getComputedStyle(tab).borderTopStyle).toBe('solid')
    expect(getComputedStyle(tab).borderTopWidth).toBe('1px')
    expect(single.container.querySelectorAll('.group-poster .folder-grid .slot')).toHaveLength(3)
    expect(single.container.querySelector('img.poster')).toBeNull()
    await single.unmount()

    const collage = await render(<IntlRoot><GroupPoster groupId="g1" icon={DEFAULT_ICON} previewHashes={hashes}/></IntlRoot>)
    await expect.poll(() => collage.container.querySelectorAll('.group-poster .folder-grid img').length).toBe(4)
    expect(collage.container.querySelector('.group-poster .folder-tab')).not.toBeNull()
    await collage.unmount()

    const { hash: customHash } = await saveGroupImage('g2', pngBlob)
    await loadCachedThumbnails([groupImageKey('g2', customHash)])
    const custom = await render(<IntlRoot><GroupPoster groupId="g2" icon={{ kind: 'image', hash: customHash }} previewHashes={[]}/></IntlRoot>)
    await expect.poll(() => custom.container.querySelector('.group-poster .folder-cover img')?.getAttribute('src')).toMatch(/^blob:/)
    expect(custom.container.querySelector('.group-poster .folder-tab')).not.toBeNull()

    await setGroupIcon('g2', { kind: 'preset', icon: 'star' })
    const previousKey = await clearGroupAppearance('g2')
    expect(previousKey).toBeNull()
  })
})

describe('GroupNameDialog', () => {
  it('enables Save when only a preset icon changes and allows choosing a custom image file', async () => {
    const onSave = vi.fn()
    const screen = await render(
      <IntlRoot>
        <GroupNameDialog title="Movies" groupId="g1" name="Movies" icon={DEFAULT_ICON} onCancel={vi.fn()} onSave={onSave}/>
      </IntlRoot>,
    )
    const save = screen.getByRole('button', { name: 'Save', exact: true })
    await expect.element(save).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Film icon' }))
    await expect.element(save).toBeEnabled()
    await userEvent.click(save)
    expect(onSave).toHaveBeenCalledWith({
      name: 'Movies',
      icon: { kind: 'preset', icon: 'film' },
      imageFile: null,
    })
    await screen.unmount()

    onSave.mockClear()
    const screen2 = await render(
      <IntlRoot>
        <GroupNameDialog title="New group" onCancel={vi.fn()} onSave={onSave}/>
      </IntlRoot>,
    )
    const file = new File([PNG_2X2], 'cover.png', { type: 'image/png' })
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(fileInput, file)
    await expect.poll(() => document.body.querySelector('img.image-preview')).not.toBeNull()
    await userEvent.type(document.body.querySelector('label.name input')!, 'Artworks')
    await userEvent.click(screen2.getByRole('button', { name: 'Save', exact: true }))
    expect(onSave).toHaveBeenCalledWith({
      name: 'Artworks',
      icon: DEFAULT_ICON,
      imageFile: file,
    })
  })
})

describe('TorrentTable inline groups', () => {
  it('renders expandable group rows with indented member rows and persistent order storage', async () => {
    const t1 = mkTorrent('a')
    const t2 = mkTorrent('b')
    const group = mkGroup('g1', 'Media', [hash('a'), hash('b')])
    const summary = summarizeGroup(group, [t1, t2], 'added', 'desc')
    const onToggleExpand = vi.fn()
    const onGroupOptions = vi.fn()

    const collapsed = await render(
      <IntlRoot>
        <TorrentTable
          entries={[{ kind: 'group', key: 'g:g1', group, summary }]}
          expandedGroups={new Set()}
          onToggleExpand={onToggleExpand}
          onGroupOptions={onGroupOptions}
          sortKey="custom"
          sortDir="asc"
          onSort={vi.fn()}
          selectedId={null}
          onSelect={vi.fn()}
          onOptions={vi.fn()}
          picked={new Set()}
          onPick={vi.fn()}
        />
      </IntlRoot>,
    )
    expect(collapsed.container.querySelectorAll('tbody tr.group-row')).toHaveLength(1)
    expect(collapsed.container.querySelectorAll('tbody tr.group-child')).toHaveLength(0)

    await userEvent.click(collapsed.container.querySelector('tr.group-row button.expand')!)
    expect(onToggleExpand).toHaveBeenCalledWith('g1')
    await userEvent.click(collapsed.container.querySelector('tr.group-row button.more')!)
    expect(onGroupOptions).toHaveBeenCalledWith(group, null)

    const expanded = await render(
      <IntlRoot>
        <TorrentTable
          entries={[{ kind: 'group', key: 'g:g1', group, summary }]}
          expandedGroups={new Set(['g1'])}
          onToggleExpand={onToggleExpand}
          onGroupOptions={onGroupOptions}
          sortKey="custom"
          sortDir="asc"
          onSort={vi.fn()}
          selectedId={null}
          onSelect={vi.fn()}
          onOptions={vi.fn()}
          picked={new Set()}
          onPick={vi.fn()}
        />
      </IntlRoot>,
    )
    expect(expanded.container.querySelectorAll('tbody tr.group-child')).toHaveLength(2)

    await saveTopOrder(['g:g1'])
    await saveGroupMemberOrder('g1', [hash('b'), hash('a')])
    expect(EMPTY_LIST_ORDER.top).toEqual([])
  })

  it('styles a 1-torrent group row in TorrentTable with folder surface, 2x2 mini icon, and folder count badge', async () => {
    const t1 = mkTorrent('a')
    const loose = mkTorrent('c')
    const pngBlob = new Blob([PNG_2X2], { type: 'image/png' })
    await saveCustomThumbnail(hash('a'), pngBlob)
    await loadCachedThumbnails([hash('a')])

    const group = mkGroup('g1', 'Single Folder', [hash('a')])
    const summary = summarizeGroup(group, [t1], 'added', 'desc')
    const screen = await render(
      <IntlRoot>
        <TorrentTable
          entries={[
            { kind: 'group', key: 'g:g1', group, summary },
            { kind: 'torrent', key: `t:${loose.id}`, torrent: loose },
          ]}
          expandedGroups={new Set()}
          onToggleExpand={vi.fn()}
          onGroupOptions={vi.fn()}
          sortKey="custom"
          sortDir="asc"
          onSort={vi.fn()}
          selectedId={null}
          onSelect={vi.fn()}
          onOptions={vi.fn()}
          picked={new Set()}
          onPick={vi.fn()}
        />
      </IntlRoot>,
    )

    const groupTr = screen.container.querySelector('tbody tr.group-row')!
    const looseTr = screen.container.querySelector('tbody tr:not(.group-row)')!
    expect(groupTr.querySelector('td.check button.expand')).not.toBeNull()
    expect(looseTr.querySelector('td.check button.expand')).toBeNull()
    expect(getComputedStyle(groupTr.querySelector('.cell-name span.title')!).fontWeight).toBe('600')
    await expect.poll(() => groupTr.querySelectorAll('.cell-name img').length).toBe(1)
    expect(groupTr.querySelectorAll('.cell-name .slot')).toHaveLength(3)
    expect(groupTr.querySelector('.group-count svg.lucide-folder')).not.toBeNull()
    expect(groupTr.querySelector('.group-count')?.textContent).toBe('1')
  })
})
