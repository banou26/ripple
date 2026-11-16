import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { del, get, set } from 'idb-keyval'

import type { StoredGroups, TorrentGroup } from '../../src/torrent/groups'
import type { Persisted } from '../../src/torrent/library'

/*
 * The groups follow a signed-in person as one sealed file, merged both ways. The Map stands for the storage of
 * whichever account is signed in.
 */
const cloudText = new Map<string, string>()
const written: string[] = []
let accountName = 'someone'
let accountChanged: (() => void) | undefined
let groupsReadFails = false
let groupsWriteFails = false
let listReadFails = false
let holdGroupsRead: Promise<void> | undefined
let holdListWrite: Promise<void> | undefined
let listWriteHeld = false
let groupsReads = 0
let cleared = 0
const listeners = new Set<(list: Persisted[]) => void>()

vi.mock('@fkn/lib', () => ({
  account: {
    info: async () => ({ name: accountName }),
    onChange: async (cb: () => void) => { accountChanged = cb; return () => {} },
  },
  cloud: {
    fs: {
      available: async () => true,
      unlock: async () => false,
      promises: {
        readFile: async (path: string) => {
          const hit = cloudText.get(path)
          if (path === 'ripple/torrents.json' && listReadFails) throw new Error('storage: read failed (500)')
          if (path === 'ripple/groups.json') {
            if (groupsReadFails) throw new Error('storage: read failed (500)')
            const hold = holdGroupsRead
            holdGroupsRead = undefined
            await hold
            groupsReads++
          }
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => {
          if (path === 'ripple/torrents.json' && holdListWrite) {
            const hold = holdListWrite
            holdListWrite = undefined
            listWriteHeld = true
            await hold
          }
          if (path === 'ripple/groups.json' && groupsWriteFails) throw new Error('storage: write failed (500)')
          written.push(path)
          cloudText.set(path, data)
        },
      },
    },
  },
}))

const client = {
  onOwnership: (cb: (owned: boolean) => void) => { cb(true); return () => {} },
  onList: (cb: (list: Persisted[]) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  importList: () => {},
  clearList: () => { cleared++ },
}
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

vi.mock('../../src/torrent/thumbnail-sync', () => ({
  forgetSyncedThumbnails: async () => {},
  resetThumbnailSync: () => {},
  syncThumbnails: async () => {},
}))

vi.mock('../../src/torrent/torrent-file-sync', () => ({
  followAccount: () => {},
  forgetSyncedTorrentFiles: async () => {},
  syncTorrentFiles: async () => {},
}))

const { BACKUP_PATH, GROUPS_PATH, REMOVALS_PATH, useCloudBackup } = await import('../../src/torrent/use-cloud-backup')
const { GROUPS_KEY, accountTag, createGroup, mergeGroups } = await import('../../src/torrent/groups')
const { SYNC_ACCOUNT_KEY } = await import('../../src/torrent/constants')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const group = (id: string, name: string, hashes: string[]): TorrentGroup =>
  ({ id, name, namedAt: 1, members: hashes.map((infoHash) => ({ infoHash, at: 1 })) })
const entry = (infoHash: string): Persisted =>
  ({ infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1_000 })
const stored = () => get<StoredGroups>(GROUPS_KEY)
const listChanged = () => { for (const listener of listeners) listener([entry(A)]) }
const writesOf = (path: string) => written.filter((p) => p === path).length

const Harness = () => <div data-testid="status">{useCloudBackup().status}</div>
const synced = async () => {
  const screen = await render(<Harness/>)
  await expect.element(screen.getByTestId('status'), { timeout: 15_000 }).toHaveTextContent('synced')
  return screen
}

let tabs = 0

beforeEach(async () => {
  cloudText.clear()
  cloudText.set(BACKUP_PATH, '[]')
  written.length = 0
  accountName = 'someone'
  groupsReadFails = false
  groupsWriteFails = false
  listReadFails = false
  holdGroupsRead = undefined
  holdListWrite = undefined
  listWriteHeld = false
  groupsReads = 0
  accountChanged = undefined
  cleared = 0
  localStorage.setItem(SYNC_ACCOUNT_KEY, 'someone')
  await del(GROUPS_KEY)
})
// a render is unmounted before the next test, and its write still armed would land there: with another account named, it does not
afterEach(() => { localStorage.removeItem(SYNC_ACCOUNT_KEY) })
afterAll(async () => { await del(GROUPS_KEY) })

describe('groups synced to the account', () => {
  it('brings the account\'s groups into this browser, and writes back the ones only this browser had', async () => {
    // a first sign-in: groups made before it are adopted, as the list is
    localStorage.removeItem(SYNC_ACCOUNT_KEY)
    const madeHere = group('made-here-group0', 'Made here', [A])
    const fromLaptop = group('from-laptop-grp0', 'From the laptop', [B])
    await set(GROUPS_KEY, { account: null, groups: [madeHere] } satisfies StoredGroups)
    cloudText.set(GROUPS_PATH, JSON.stringify([fromLaptop]))
    await synced()

    const both = mergeGroups([madeHere, fromLaptop])
    expect(await stored()).toEqual({ account: await accountTag('someone'), groups: both })
    expect(cloudText.get(GROUPS_PATH)).toBe(JSON.stringify(both))
    // one fixed name, whatever the groups hold
    for (const path of written) expect([BACKUP_PATH, REMOVALS_PATH, GROUPS_PATH]).toContain(path)
  }, 40_000)

  it('sends this browser\'s groups to an account that has no backup at all yet', async () => {
    localStorage.removeItem(SYNC_ACCOUNT_KEY)
    cloudText.delete(BACKUP_PATH)
    const madeHere = mergeGroups([group('made-here-group0', 'Made here', [A])])
    await set(GROUPS_KEY, { account: null, groups: madeHere } satisfies StoredGroups)
    await synced()

    expect(cloudText.get(GROUPS_PATH)).toBe(JSON.stringify(madeHere))
    expect(await stored()).toEqual({ account: await accountTag('someone'), groups: madeHere })
  }, 40_000)

  it('writes the file only when this browser knew something it did not', async () => {
    const shared = mergeGroups([group('shared-group-000', 'Shared', [A])])
    await set(GROUPS_KEY, { account: await accountTag('someone'), groups: shared } satisfies StoredGroups)
    cloudText.set(GROUPS_PATH, JSON.stringify(shared))
    await synced()
    listChanged()
    // the restore's read, then the list write's
    await expect.poll(() => groupsReads, { timeout: 15_000 }).toBe(2)
    expect(writesOf(BACKUP_PATH)).toBe(1)

    // control: one more group, and the next write sends it
    await createGroup('Weekend', [B])
    await expect.poll(() => cloudText.get(GROUPS_PATH), { timeout: 15_000 }).toContain('"Weekend"')
    expect(writesOf(GROUPS_PATH)).toBe(1)
  }, 40_000)

  it('publishes an edit made in this tab or in another, with no change to the list', async () => {
    await synced()
    await createGroup('From this tab', [A])
    await expect.poll(() => cloudText.get(GROUPS_PATH) ?? '', { timeout: 15_000 }).toContain('"From this tab"')

    const otherTab: typeof import('../../src/torrent/groups') = await import(/* @vite-ignore */ `../../src/torrent/groups.ts?tab=${++tabs}`)
    await otherTab.createGroup('From another tab', [A])
    await expect.poll(() => cloudText.get(GROUPS_PATH) ?? '', { timeout: 15_000 }).toContain('"From another tab"')
  }, 40_000)

  it('leaves out a copy of another account, when a ripple from before groups switched accounts', async () => {
    // that ripple already named this account and cleared the list, so this tab sees no switch
    await set(GROUPS_KEY, {
      account: await accountTag('earlier'),
      groups: [group('earlier-acct-grp', 'Earlier account', [A])],
    } satisfies StoredGroups)
    const theirs = mergeGroups([group('account-copy-grp', 'In the account', [B])])
    cloudText.set(GROUPS_PATH, JSON.stringify(theirs))
    await synced()

    expect(cleared).toBe(0)
    expect(await stored()).toEqual({ account: await accountTag('someone'), groups: theirs })
    expect(writesOf(GROUPS_PATH)).toBe(0)
  }, 40_000)

  it('drops every group this browser held on an account switch it handles, tagged or not', async () => {
    localStorage.setItem(SYNC_ACCOUNT_KEY, 'earlier')
    await set(GROUPS_KEY, { account: null, groups: [group('made-before-grp0', 'Made before', [A])] } satisfies StoredGroups)
    const theirs = mergeGroups([group('account-copy-grp', 'In the account', [B])])
    cloudText.set(GROUPS_PATH, JSON.stringify(theirs))
    await synced()

    expect(cleared).toBe(1)
    expect(await stored()).toEqual({ account: await accountTag('someone'), groups: theirs })
    expect(writesOf(GROUPS_PATH)).toBe(0)
  }, 40_000)

  it('never writes over a file it could not read, and keeps this browser\'s groups as they were', async () => {
    groupsReadFails = true
    const mine = { account: await accountTag('someone'), groups: mergeGroups([group('made-here-group0', 'Made here', [A])]) }
    await set(GROUPS_KEY, mine satisfies StoredGroups)
    await synced()
    listChanged()
    await expect.poll(() => writesOf(BACKUP_PATH), { timeout: 15_000 }).toBe(1)
    // a second write 3 s later, so the first one's groups step is over
    listChanged()
    await expect.poll(() => writesOf(BACKUP_PATH), { timeout: 15_000 }).toBe(2)

    expect(writesOf(GROUPS_PATH)).toBe(0)
    expect(await stored()).toEqual(mine)
  }, 40_000)

  it('never writes over a file whose read the broker did not answer', async () => {
    const mine = { account: await accountTag('someone'), groups: mergeGroups([group('made-here-group0', 'Made here', [A])]) }
    await set(GROUPS_KEY, mine satisfies StoredGroups)
    const theirs = JSON.stringify(mergeGroups([group('account-copy-grp', 'In the account', [B])]))
    cloudText.set(GROUPS_PATH, theirs)
    // the restore gives up on it after its 10 s bound
    holdGroupsRead = new Promise(() => {})
    const screen = await render(<Harness/>)
    await expect.element(screen.getByTestId('status'), { timeout: 20_000 }).toHaveTextContent('synced')

    expect(writesOf(GROUPS_PATH)).toBe(0)
    expect(cloudText.get(GROUPS_PATH)).toBe(theirs)
    expect(await stored()).toEqual(mine)
  }, 40_000)

  it('replaces a file that does not parse with this browser\'s groups, in the restore and in a write', async () => {
    const mine = mergeGroups([group('made-here-group0', 'Made here', [A])])
    await set(GROUPS_KEY, { account: await accountTag('someone'), groups: mine } satisfies StoredGroups)
    cloudText.set(GROUPS_PATH, '{not json')
    const screen = await synced()
    expect(cloudText.get(GROUPS_PATH)).toBe(JSON.stringify(mine))

    cloudText.set(GROUPS_PATH, '{not json')
    listChanged()
    await expect.poll(() => cloudText.get(GROUPS_PATH), { timeout: 15_000 }).toBe(JSON.stringify(mine))
    await expect.element(screen.getByTestId('status')).toHaveTextContent('synced')
  }, 40_000)

  it('keeps the list synced when the restore cannot write the groups, and the next write sends them', async () => {
    const mine = mergeGroups([group('made-here-group0', 'Made here', [A])])
    await set(GROUPS_KEY, { account: await accountTag('someone'), groups: mine } satisfies StoredGroups)
    groupsWriteFails = true
    await synced()
    expect(cloudText.has(GROUPS_PATH)).toBe(false)

    groupsWriteFails = false
    listChanged()
    await expect.poll(() => cloudText.get(GROUPS_PATH), { timeout: 15_000 }).toBe(JSON.stringify(mine))
  }, 40_000)

  it('keeps and reports nothing from a restore that went stale while it read the groups', async () => {
    localStorage.removeItem(SYNC_ACCOUNT_KEY)
    accountName = 'first'
    const first = JSON.stringify([group('first-account-gp', 'First account', [A])])
    cloudText.set(GROUPS_PATH, first)
    let release = () => {}
    holdGroupsRead = new Promise((resolve) => { release = resolve })
    const screen = await render(<Harness/>)
    await expect.poll(() => holdGroupsRead === undefined && accountChanged !== undefined, { timeout: 15_000 }).toBe(true)

    // the account changes while the first one's groups are read, and the second one's list cannot be read yet
    accountName = 'second'
    listReadFails = true
    accountChanged!()
    await expect.element(screen.getByTestId('status'), { timeout: 15_000 }).toHaveTextContent('error')

    release()
    await expect.poll(() => groupsReads, { timeout: 15_000 }).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await stored()).toBeUndefined()
    expect(screen.getByTestId('status').element().textContent).toBe('error')
    expect(cloudText.get(GROUPS_PATH)).toBe(first)
    expect(writesOf(GROUPS_PATH)).toBe(0)
  }, 40_000)

  it('keeps a write\'s groups out of the account signed into while its list was on the way', async () => {
    accountName = 'first'
    localStorage.setItem(SYNC_ACCOUNT_KEY, 'first')
    const firsts = mergeGroups([group('first-account-gp', 'First account', [A])])
    await set(GROUPS_KEY, { account: await accountTag('first'), groups: firsts } satisfies StoredGroups)
    cloudText.set(GROUPS_PATH, JSON.stringify(firsts))
    const screen = await synced()
    let release = () => {}
    holdListWrite = new Promise((resolve) => { release = resolve })
    listChanged()
    await expect.poll(() => listWriteHeld, { timeout: 15_000 }).toBe(true)

    // from here the Map is the second account's storage
    const seconds = mergeGroups([group('second-acct-grp0', 'Second account', [B])])
    cloudText.set(GROUPS_PATH, JSON.stringify(seconds))
    accountName = 'second'
    accountChanged!()
    release()
    await expect.poll(() => localStorage.getItem(SYNC_ACCOUNT_KEY), { timeout: 15_000 }).toBe('second')
    await expect.element(screen.getByTestId('status'), { timeout: 15_000 }).toHaveTextContent('synced')
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(cloudText.get(GROUPS_PATH)).toBe(JSON.stringify(seconds))
    expect(await stored()).toEqual({ account: await accountTag('second'), groups: seconds })
  }, 40_000)
})
