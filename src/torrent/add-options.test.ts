import { describe, expect, it } from 'vitest'

import { PRIORITY, TORRENT_FLAG } from 'libtorrent-wasm'

import {
  ADD_DIALOG_KEY,
  choicesProblem,
  defaultChoices,
  dialogEnabled,
  filePriorities,
  flagsFor,
  selectAll,
  selectNone,
  selectedBytes,
  toggleFile,
} from './add-options'

/**
 * The decisions the add dialog offers, with no dialog in sight.
 *
 * Two of these carry real weight. Skipping a file is a priority of 0, which means never download,
 * and it has to be expressed per FILE so libtorrent can keep fetching a piece that straddles a
 * skipped file and a wanted one. And selecting nothing has to be caught here, because the engine
 * accepts it happily and the result looks like a stalled download rather than like a mistake.
 */

const files = [{ size: 100 }, { size: 200 }, { size: 300 }]
const base = defaultChoices({ fileCount: 3, location: 'browser' })

describe('what a torrent starts with', () => {
  it('wants every file, started, in the usual order', () => {
    expect(base).toEqual({ files: [0, 1, 2], location: 'browser', start: true, sequential: false, topOfQueue: false })
  })

  it('takes the save location it was given rather than assuming one', () => {
    expect(defaultChoices({ fileCount: 1, location: 'folder' }).location).toBe('folder')
  })

  it('copes with a torrent whose file list has not arrived', () => {
    expect(defaultChoices({ fileCount: 0, location: 'browser' }).files).toEqual([])
  })
})

describe('the dialog is off unless it was turned on', () => {
  it('stays off when nothing was stored', () => {
    expect(dialogEnabled(() => null)).toBe(false)
  })

  it('is on only for the exact stored value', () => {
    expect(dialogEnabled((k) => (k === ADD_DIALOG_KEY ? '1' : null))).toBe(true)
    for (const junk of ['true', 'yes', '0', '']) expect(dialogEnabled(() => junk)).toBe(false)
  })

  it('stays off when storage throws, as it does in a locked-down browser', () => {
    expect(dialogEnabled(() => { throw new Error('denied') })).toBe(false)
  })
})

describe('turning choices into priorities', () => {
  it('gives every wanted file the ordinary priority', () => {
    expect(filePriorities(base, 3)).toEqual([PRIORITY.normal, PRIORITY.normal, PRIORITY.normal])
  })

  it('skips the ones nobody asked for, and skip is zero', () => {
    expect(filePriorities({ ...base, files: [1] }, 3)).toEqual([PRIORITY.skip, PRIORITY.normal, PRIORITY.skip])
    expect(PRIORITY.skip).toBe(0)
  })

  it('answers for every file even when the selection names one that does not exist', () => {
    expect(filePriorities({ ...base, files: [0, 9] }, 3)).toEqual([PRIORITY.normal, PRIORITY.skip, PRIORITY.skip])
  })
})

describe('turning choices into flags', () => {
  it('names the sequential bit in the mask whether it is on or off, or it can never be turned OFF', () => {
    expect(flagsFor({ ...base, sequential: true })).toEqual([TORRENT_FLAG.sequentialDownload, TORRENT_FLAG.sequentialDownload])
    expect(flagsFor({ ...base, sequential: false })).toEqual([0, TORRENT_FLAG.sequentialDownload])
  })
})

describe('refusing a selection that would look like a bug', () => {
  it('catches selecting nothing, which the engine accepts and then sits at 0% forever', () => {
    expect(choicesProblem(selectNone(base))).toMatch(/at least one file/)
  })

  it('is happy with anything else', () => {
    expect(choicesProblem(base)).toBe(null)
    expect(choicesProblem({ ...base, files: [2] })).toBe(null)
  })
})

describe('editing the selection', () => {
  it('toggles one file off and back on, keeping the order stable', () => {
    const without = toggleFile(base, 1)
    expect(without.files).toEqual([0, 2])
    expect(toggleFile(without, 1).files).toEqual([0, 1, 2])
  })

  it('selects all and none', () => {
    expect(selectNone(base).files).toEqual([])
    expect(selectAll(selectNone(base), 3).files).toEqual([0, 1, 2])
  })

  it('leaves every other choice alone while the selection changes', () => {
    const chosen = { ...base, location: 'folder' as const, sequential: true, start: false, topOfQueue: true }
    const { files: _, ...rest } = toggleFile(chosen, 0)
    expect(rest).toEqual({ location: 'folder', sequential: true, start: false, topOfQueue: true })
  })
})

describe('the size actually being downloaded', () => {
  it('adds up only what is selected', () => {
    expect(selectedBytes(base, files)).toBe(600)
    expect(selectedBytes({ ...base, files: [0, 2] }, files)).toBe(400)
    expect(selectedBytes(selectNone(base), files)).toBe(0)
  })

  it('ignores an index with no file behind it', () => {
    expect(selectedBytes({ ...base, files: [0, 42] }, files)).toBe(100)
  })
})
