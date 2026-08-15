import type { Torrent } from './types'
import type { TorrentOptionContext } from './torrent-options'

import { describe, expect, it, vi } from 'vitest'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { buildTorrentOptions } from './torrent-options'

/**
 * The option list, which is the single definition both the right-click menu and the options dialog
 * render.
 *
 * The one that matters most is the discovery settings. libtorrent stores them in the NEGATIVE
 * (`disable_dht`, `disable_pex`) and the controls now say so too, matching qBittorrent's own
 * "Disable DHT for this torrent". That removed an inversion the UI used to perform on the way in and
 * out, which was a needless place to get a switch backwards: a mistake there turns the thing off
 * while the label says on, with no error and nothing on screen to contradict it. Asserted in both
 * directions against the flag constants rather than numbers, so it survives libtorrent renumbering.
 *
 * The rest is about not offering controls that cannot do anything: a torrent that is not in the
 * session, a queue move for something that is not queued, super seeding on an incomplete torrent.
 */

const torrent = (over: Partial<Torrent> = {}): Torrent => ({
  id: '7',
  infoHash: 'aabbccddeeff00112233445566778899aabbccdd',
  magnet: 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd',
  name: 'Big Buck Bunny',
  size: 2_000_000_000,
  downloaded: 1_000_000_000,
  progress: 0.5,
  state: 'downloading',
  down: 0,
  up: 0,
  peers: 4,
  seeds: 1,
  eta: '4m',
  flags: 0,
  queuePosition: -1,
  stats: {
    allTimeDownload: 1_000_000_000,
    allTimeUpload: 250_000_000,
    sessionDownload: 500_000_000,
    sessionUpload: 100_000_000,
    wasted: 4096,
    swarmSeeds: 40,
    swarmPeers: 12,
    numConnections: 6,
    connectionsLimit: 200,
    availability: 2.4,
    activeSeconds: 3600,
    seedingSeconds: 120,
    addedAt: 1_755_000_000,
    completedAt: 1_755_003_600,
    lastSeenComplete: 1_755_003_600,
    hadIncoming: true,
    savePath: '/downloads',
    pieceLength: 262_144,
    numPieces: 7630,
    numPiecesHave: 3815,
  },
  files: [{ name: 'a.mkv', size: 1e9, progress: 0.5 }],
  ...over,
})

const actions = () => ({
  setFlags: vi.fn(),
  reannounce: vi.fn(),
  moveInQueue: vi.fn(),
  recheck: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
  removeWithFiles: vi.fn(),
  release: vi.fn(),
  setLocation: vi.fn(),
  setFirstLast: vi.fn(),
  pickFolder: vi.fn(),
  watch: vi.fn(),
  save: vi.fn(),
  embed: vi.fn(),
  retryNow: vi.fn(),
  start: vi.fn(),
})

const flat = (t: Torrent, a = actions(), saved = false) =>
  buildTorrentOptions(t, a, { savedToUserStorage: saved }).flatMap((g) => g.items)
const find = (t: Torrent, id: string, a = actions(), saved = false) =>
  flat(t, a, saved).find((i) => i.id === id)

describe('the torrent option list', () => {
  describe('the discovery settings, which read the same way libtorrent stores them', () => {
    it('reads unticked when the disable flag is absent, which is the DHT running', () => {
      const dht = find(torrent({ flags: 0 }), 'dht')!
      expect(dht.kind).toBe('toggle')
      expect(dht.kind === 'toggle' && dht.checked).toBe(false)
    })

    it('reads ticked when the disable flag is set', () => {
      const dht = find(torrent({ flags: TORRENT_FLAG.disableDht }), 'dht')!
      expect(dht.kind === 'toggle' && dht.checked).toBe(true)
    })

    /** Ticking "Disable DHT" must SET the flag. The direction a wrong sign would silently invert. */
    it('sets the disable flag when the user ticks it', () => {
      const a = actions()
      const dht = find(torrent({ flags: 0 }), 'dht', a)!
      if (dht.kind !== 'toggle') throw new Error('not a toggle')
      dht.apply(true)
      expect(a.setFlags).toHaveBeenCalledWith(TORRENT_FLAG.disableDht, TORRENT_FLAG.disableDht)
    })

    it('clears it when the user unticks it', () => {
      const a = actions()
      const dht = find(torrent({ flags: TORRENT_FLAG.disableDht }), 'dht', a)!
      if (dht.kind !== 'toggle') throw new Error('not a toggle')
      dht.apply(false)
      expect(a.setFlags).toHaveBeenCalledWith(0, TORRENT_FLAG.disableDht)
    })

    it('does the same for peer exchange', () => {
      const a = actions()
      const pex = find(torrent({ flags: TORRENT_FLAG.disablePex }), 'pex', a)!
      if (pex.kind !== 'toggle') throw new Error('not a toggle')
      expect(pex.checked).toBe(true)
      pex.apply(false)
      expect(a.setFlags).toHaveBeenCalledWith(0, TORRENT_FLAG.disablePex)
    })

    /**
     * The labels are qBittorrent's, deliberately and not approximately. Somebody arriving from it
     * should not have to work out that "Ask trackers again now" was "Force reannounce".
     */
    it('uses the names a qBittorrent user already knows', () => {
      const ids = flat(torrent({ progress: 1, queuePosition: 0 }), actions(), true)
      const label = (id: string) => ids.find((i) => i.id === id)?.label
      expect(label('dht')).toBe('Disable DHT for this torrent')
      expect(label('pex')).toBe('Disable PeX for this torrent')
      expect(label('reannounce')).toBe('Force reannounce')
      expect(label('recheck')).toBe('Force recheck')
      expect(label('super-seed')).toBe('Super seeding mode')
      expect(label('order-sequential')).toBe('Download in sequential order')
      expect(label('queue-top')).toBe('Move to top')
      expect(label('queue-bottom')).toBe('Move to bottom')
    })

    /**
     * The session turns LSD off outright (wrapper.cpp, `enable_lsd, false`), so a per-torrent
     * switch for it could not change an outcome. Not shipping it is the rule, and this is the
     * guard against someone adding it later because libtorrent has the flag.
     */
    it('offers no local discovery switch, because the session has no local discovery', () => {
      expect(flat(torrent()).map((i) => i.id)).not.toContain('lsd')
    })
  })

  describe('piece order', () => {
    it('is rarest first until sequential is set', () => {
      const items = flat(torrent({ flags: 0 }))
      const rarest = items.find((i) => i.id === 'order-rarest')!
      const inOrder = items.find((i) => i.id === 'order-sequential')!
      expect(rarest.kind === 'radio' && rarest.selected).toBe(true)
      expect(inOrder.kind === 'radio' && inOrder.selected).toBe(false)
    })

    /** Exactly one, always: rarest first is the absence of the flag, not a flag of its own. */
    it('never has both or neither selected', () => {
      for (const flags of [0, TORRENT_FLAG.sequentialDownload, TORRENT_FLAG.disableDht]) {
        const chosen = flat(torrent({ flags }))
          .filter((i) => i.kind === 'radio' && i.group === 'order' && i.selected)
        expect(chosen).toHaveLength(1)
      }
    })

    it('clears the flag for rarest first and sets it for in-order', () => {
      const a = actions()
      const items = flat(torrent({ flags: 0 }), a)
      const rarest = items.find((i) => i.id === 'order-rarest')!
      const inOrder = items.find((i) => i.id === 'order-sequential')!
      if (rarest.kind !== 'radio' || inOrder.kind !== 'radio') throw new Error('not radios')
      rarest.apply()
      expect(a.setFlags).toHaveBeenLastCalledWith(0, TORRENT_FLAG.sequentialDownload)
      inOrder.apply()
      expect(a.setFlags).toHaveBeenLastCalledWith(TORRENT_FLAG.sequentialDownload, TORRENT_FLAG.sequentialDownload)
    })

    it('is disabled once there is nothing left to download', () => {
      const rarest = find(torrent({ progress: 1 }), 'order-rarest')!
      expect(rarest.disabled).toBeTruthy()
    })
  })

  describe('what is offered at all', () => {
    /**
     * libtorrent ignores super seeding while pieces are missing, so offering it then would be a
     * switch that flips itself back and reads as a bug in Ripple.
     */
    it('withholds super seeding until the download has finished', () => {
      expect(find(torrent({ progress: 0.5 }), 'super-seed')!.disabled).toBeTruthy()
      expect(find(torrent({ progress: 1 }), 'super-seed')!.disabled).toBeUndefined()
    })

    it('hides queue moves for a torrent that is not queued', () => {
      expect(flat(torrent({ queuePosition: -1 })).map((i) => i.id)).not.toContain('queue-top')
      expect(flat(torrent({ queuePosition: 2 })).map((i) => i.id)).toContain('queue-top')
    })

    it('counts the queue position from one, the way a person does', () => {
      const groups = buildTorrentOptions(torrent({ queuePosition: 2 }), actions())
      expect(groups.find((g) => g.id === 'queue')!.label).toBe('Queue position 3')
    })

    it('moves the torrent the way the item says', () => {
      const a = actions()
      const item = find(torrent({ queuePosition: 1 }), 'queue-bottom', a)!
      if (item.kind !== 'action') throw new Error('not an action')
      item.run()
      expect(a.moveInQueue).toHaveBeenCalledWith('bottom')
    })

    it('offers Resume for a stopped torrent and Pause for a running one', () => {
      expect(find(torrent({ state: 'paused' }), 'toggle-run')!.label).toBe('Resume')
      expect(find(torrent({ state: 'queued' }), 'toggle-run')!.label).toBe('Resume')
      expect(find(torrent({ state: 'downloading' }), 'toggle-run')!.label).toBe('Pause')
    })

    it('does not offer a second check while one is running', () => {
      expect(find(torrent({ state: 'checking' }), 'recheck')!.disabled).toBeTruthy()
    })
  })

  /**
   * A library ghost is a torrent this device knows about and has not added to the session. It has
   * no engine handle, so every setter would be aimed at nothing, and its `flags` of 0 would
   * otherwise read as "every option deliberately off".
   */
  describe('a torrent that is not running here', () => {
    const ghost = torrent({ state: 'missing', flags: 0, queuePosition: -1 })

    it('disables everything that would talk to the engine', () => {
      for (const id of ['dht', 'pex', 'reannounce', 'upload-only', 'super-seed', 'order-rarest', 'recheck']) {
        expect(find(ghost, id)!.disabled, id).toBeTruthy()
      }
    })

    it('still lets it be removed, since that is the whole point of the entry', () => {
      expect(find(ghost, 'remove')!.disabled).toBeUndefined()
    })

    /** There is nothing on this device to delete, so the option is absent rather than greyed. */
    it('does not offer to delete files it does not have', () => {
      expect(flat(ghost).map((i) => i.id)).not.toContain('remove-files')
    })

    it('does not claim its files are being left anywhere', () => {
      expect(find(ghost, 'remove')!.hint).not.toContain('folder')
    })
  })

  /**
   * "Remove but keep the files" is only a real choice when there are files to keep. Ripple
   * downloads into OPFS, which has no path and no file manager entry and cannot be reached except
   * through Ripple, so against OPFS alone the option promises to preserve something nobody can
   * ever open, while still spending the origin quota to hold it.
   */
  describe('the destructive items', () => {
    it('offers only a full delete while the files live in OPFS alone', () => {
      const ids = flat(torrent(), actions(), false).map((i) => i.id)
      expect(ids).not.toContain('remove')
      expect(ids).toContain('remove-files')
    })

    it('offers both once a copy is in the user\'s own folder', () => {
      const ids = flat(torrent(), actions(), true).map((i) => i.id)
      expect(ids).toContain('remove')
      expect(ids).toContain('remove-files')
    })

    /** With a copy safely elsewhere, the delete is about reclaiming space, and says so. */
    it('renames the delete once it is only removing Ripple\'s copy', () => {
      expect(find(torrent(), 'remove-files', actions(), false)!.label).toBe('Remove and delete the files')
      expect(find(torrent(), 'remove-files', actions(), true)!.label).toBe("Remove and delete Ripple's copy")
    })

    it('separates the two, and marks both as destructive', () => {
      const a = actions()
      const keep = find(torrent(), 'remove', a, true)!
      const wipe = find(torrent(), 'remove-files', a, true)!
      if (keep.kind !== 'action' || wipe.kind !== 'action') throw new Error('not actions')
      expect(keep.danger).toBe(true)
      expect(wipe.danger).toBe(true)
      keep.run()
      expect(a.remove).toHaveBeenCalled()
      expect(a.removeWithFiles).not.toHaveBeenCalled()
      wipe.run()
      expect(a.removeWithFiles).toHaveBeenCalled()
    })
  })

  /**
   * qBittorrent has this beside sequential rather than inside it, and so does this: it composes with
   * the piece order rather than replacing it. Its state comes from the library entry, because the
   * engine's own piece map does not survive a reload.
   */
  describe('download first and last pieces first', () => {
    it('reads its state off the torrent rather than remembering a click', () => {
      expect(find(torrent({ firstLast: true }), 'first-last')).toMatchObject({ checked: true })
      expect(find(torrent({ firstLast: false }), 'first-last')).toMatchObject({ checked: false })
      expect(find(torrent({}), 'first-last')).toMatchObject({ checked: false })
    })

    it('applies in both directions', () => {
      const a = actions()
      const item = find(torrent(), 'first-last', a)!
      if (item.kind !== 'toggle') throw new Error('not a toggle')
      item.apply(true)
      expect(a.setFirstLast).toHaveBeenCalledWith(true)
      item.apply(false)
      expect(a.setFirstLast).toHaveBeenCalledWith(false)
    })

    it('is not offered once there is nothing left to fetch', () => {
      expect(find(torrent({ progress: 1 }), 'first-last')!.disabled).toBeTruthy()
      expect(find(torrent({ progress: 0.5 }), 'first-last')!.disabled).toBeUndefined()
    })

    it('sits with the piece order, which is where qBittorrent puts it', () => {
      const group = buildTorrentOptions(torrent(), actions()).find((g) => g.items.some((i) => i.id === 'first-last'))
      expect(group?.items.map((i) => i.id)).toContain('order-sequential')
    })
  })

  /**
   * Where the files belong.
   *
   * Two radios and not a path field, because a browser has exactly two places to put them: its own
   * storage, which is the only one a download can be written into, and a folder the user granted,
   * which can only be reached once the download is finished. Choosing a folder for something still
   * downloading is a fair thing to ask for, so it is remembered and the hint says when it will
   * happen rather than the option refusing.
   */
  describe('choosing where the files live', () => {
    const withFolder = (over: Partial<TorrentOptionContext> = {}): TorrentOptionContext => ({
      savedToUserStorage: false, folderReady: true, folderName: 'Downloads',
      intended: 'browser', current: 'browser', ...over,
    })
    const items = (t: Torrent, context: TorrentOptionContext, a = actions()) =>
      buildTorrentOptions(t, a, context).flatMap((g) => g.items)
    const item = (t: Torrent, id: string, context: TorrentOptionContext, a = actions()) =>
      items(t, context, a).find((i) => i.id === id)

    it('is not offered at all when there is no usable folder, since one place is not a choice', () => {
      const ids = items(torrent(), withFolder({ folderReady: false })).map((i) => i.id)
      expect(ids).not.toContain('location-folder')
      expect(ids).not.toContain('location-browser')
    })

    it('offers both places once a folder is usable', () => {
      const ids = items(torrent(), withFolder()).map((i) => i.id)
      expect(ids).toContain('location-browser')
      expect(ids).toContain('location-folder')
    })

    it('names the folder rather than calling it a folder', () => {
      expect(item(torrent(), 'location-folder', withFolder())!.label).toBe('Move to Downloads')
    })

    it('marks the one that is chosen, not the one it is sitting in', () => {
      // mid-move the two disagree, and the radio has to follow the CHOICE or clicking it does nothing
      const both = items(torrent({ progress: 1 }), withFolder({ intended: 'folder', current: 'browser' }))
      const folder = both.find((i) => i.id === 'location-folder')!
      const browser = both.find((i) => i.id === 'location-browser')!
      expect(folder.kind === 'radio' && folder.selected).toBe(true)
      expect(browser.kind === 'radio' && browser.selected).toBe(false)
    })

    it('says when an unfinished torrent will move rather than refusing the choice', () => {
      const chosen = item(torrent({ progress: 0.4 }), 'location-folder', withFolder({ intended: 'folder' }))!
      expect(chosen.hint).toBe('Moves to Downloads when it finishes')
      expect(chosen.kind === 'radio' && chosen.disabled).toBeUndefined()
    })

    it('drops the pending wording once it has arrived', () => {
      const settled = item(torrent({ progress: 1 }), 'location-folder', withFolder({ intended: 'folder', current: 'folder' }))!
      expect(settled.hint).not.toMatch(/when it finishes/)
    })

    it('applies the choice through setLocation, in both directions', () => {
      const a = actions()
      const folder = item(torrent(), 'location-folder', withFolder(), a)!
      const browser = item(torrent(), 'location-browser', withFolder(), a)!
      if (folder.kind !== 'radio' || browser.kind !== 'radio') throw new Error('not radios')
      folder.apply()
      expect(a.setLocation).toHaveBeenCalledWith('folder')
      browser.apply()
      expect(a.setLocation).toHaveBeenCalledWith('browser')
    })

    it('is never offered for a ghost, which has no files anywhere to move', () => {
      const ids = items(torrent({ state: 'missing' }), withFolder()).map((i) => i.id)
      expect(ids).not.toContain('location-folder')
    })

    /**
     * qBittorrent's Set location opens a directory chooser. Ripple holds ONE granted directory, so
     * this changes it for every torrent saving there, and the hint has to say so: a per-torrent menu
     * implies per-torrent scope, and quietly moving everyone else's files would be the worst
     * surprise available here.
     */
    it('offers the folder picker, and says it is shared', () => {
      const a = actions()
      const pick = item(torrent(), 'pick-folder', withFolder(), a)!
      if (pick.kind !== 'action') throw new Error('not an action')
      expect(pick.hint).toMatch(/shared by every torrent/)
      pick.run()
      expect(a.pickFolder).toHaveBeenCalled()
    })
  })

  /**
   * Two groups both called "This torrent" made the menu read as though it repeated itself, which is
   * what shipped in the first pass. A group label is the only thing separating two lists of items
   * that are otherwise indistinguishable at a glance.
   */
  it('gives every group a distinct label', () => {
    for (const t of [torrent(), torrent({ queuePosition: 0 }), torrent({ state: 'missing' })]) {
      const labels = buildTorrentOptions(t, actions(), { savedToUserStorage: true }).map((g) => g.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  /**
   * Everything taken off the row's action strip has to be reachable here, or removing the button
   * removed the feature. The strip kept Watch, Save, Pause and Options; these are the rest.
   */
  it('carries what the row no longer has room for', () => {
    const ids = flat(torrent({ progress: 1 }), actions(), true).map((i) => i.id)
    for (const id of ['watch', 'save', 'embed', 'recheck', 'remove-files']) {
      expect(ids, id).toContain(id)
    }
  })

  it('runs each of them through the action it names', () => {
    const a = actions()
    const items = flat(torrent({ progress: 1 }), a, true)
    for (const [id, fn] of [['watch', a.watch], ['save', a.save], ['embed', a.embed]] as const) {
      const item = items.find((i) => i.id === id)!
      if (item.kind !== 'action') throw new Error(`${id} is not an action`)
      item.run()
      expect(fn, id).toHaveBeenCalled()
    }
  })

  /** A stalled torrent is waiting out a backoff, so "Resume" would do nothing for it. */
  it('offers to shorten the wait only while a retry is pending', () => {
    expect(flat(torrent({ state: 'retrying' })).map((i) => i.id)).toContain('retry-now')
    expect(flat(torrent({ state: 'downloading' })).map((i) => i.id)).not.toContain('retry-now')
  })

  it('offers a ghost a way back rather than a save it cannot do', () => {
    const ids = flat(torrent({ state: 'missing' })).map((i) => i.id)
    expect(ids).toContain('start')
    expect(ids).not.toContain('save')
  })

  it('gives every item a unique id, since both surfaces key on it', () => {
    for (const saved of [false, true]) {
      for (const t of [torrent(), torrent({ queuePosition: 0 }), torrent({ progress: 1 }), torrent({ state: 'missing' })]) {
        const ids = flat(t, actions(), saved).map((i) => i.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
    }
  })

  it('gives every item a hint, since the dialog shows one for each', () => {
    for (const item of flat(torrent({ queuePosition: 0 }))) {
      expect(item.hint.length, item.id).toBeGreaterThan(10)
    }
  })
})
