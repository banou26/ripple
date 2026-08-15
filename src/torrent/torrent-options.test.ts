import type { Torrent } from './types'

import { describe, expect, it, vi } from 'vitest'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { buildTorrentOptions } from './torrent-options'

/**
 * The option list, which is the single definition both the right-click menu and the options dialog
 * render.
 *
 * The one that matters most is the inversion. libtorrent stores the discovery settings in the
 * NEGATIVE (`disable_dht`, `disable_pex`), while the control a person sees is positive ("use the
 * DHT"). Get it backwards and the switch turns the thing off when it says on, with no error
 * anywhere and nothing on screen to contradict it. It is asserted in both directions here, against
 * the flag constants rather than against numbers, so it stays right if libtorrent renumbers.
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
})

const flat = (t: Torrent, a = actions(), saved = false) =>
  buildTorrentOptions(t, a, { savedToUserStorage: saved }).flatMap((g) => g.items)
const find = (t: Torrent, id: string, a = actions(), saved = false) =>
  flat(t, a, saved).find((i) => i.id === id)

describe('the torrent option list', () => {
  describe('the discovery settings, which libtorrent stores inverted', () => {
    it('shows the DHT as on when the disable flag is absent', () => {
      const dht = find(torrent({ flags: 0 }), 'dht')!
      expect(dht.kind).toBe('toggle')
      expect(dht.kind === 'toggle' && dht.checked).toBe(true)
    })

    it('shows the DHT as off when the disable flag is set', () => {
      const dht = find(torrent({ flags: TORRENT_FLAG.disableDht }), 'dht')!
      expect(dht.kind === 'toggle' && dht.checked).toBe(false)
    })

    /** Turning the control OFF must SET the flag. This is the direction that silently inverts. */
    it('sets the disable flag when the user turns the DHT off', () => {
      const a = actions()
      const dht = find(torrent({ flags: 0 }), 'dht', a)!
      if (dht.kind !== 'toggle') throw new Error('not a toggle')
      dht.apply(false)
      expect(a.setFlags).toHaveBeenCalledWith(TORRENT_FLAG.disableDht, TORRENT_FLAG.disableDht)
    })

    it('clears the disable flag when the user turns the DHT on', () => {
      const a = actions()
      const dht = find(torrent({ flags: TORRENT_FLAG.disableDht }), 'dht', a)!
      if (dht.kind !== 'toggle') throw new Error('not a toggle')
      dht.apply(true)
      expect(a.setFlags).toHaveBeenCalledWith(0, TORRENT_FLAG.disableDht)
    })

    it('does the same for peer exchange', () => {
      const a = actions()
      const pex = find(torrent({ flags: TORRENT_FLAG.disablePex }), 'pex', a)!
      if (pex.kind !== 'toggle') throw new Error('not a toggle')
      expect(pex.checked).toBe(false)
      pex.apply(true)
      expect(a.setFlags).toHaveBeenCalledWith(0, TORRENT_FLAG.disablePex)
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
