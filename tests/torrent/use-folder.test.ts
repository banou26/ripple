import { afterEach, describe, expect, it, vi } from 'vitest'

import { folderPickerSupported } from '../../src/torrent/use-folder'

/**
 * Whether the folder control is offered at all, which is the whole of what `supported` carries.
 *
 * A directory picker is refused in a cross-origin frame whatever the frame's sandbox tokens, and
 * `showDirectoryPicker` is still THERE to be probed, so presence alone offers a button that can only
 * turn out to be impossible once pressed. That is what ripple under https://fkn.app/app/ is: the
 * granted-directory save already fails there today.
 *
 * The React shell around this is three `useState` writes and is not covered here, for the reason
 * `use-persistent-storage.test.ts` records: the unit project runs in node with no DOM, so what is
 * tested is the predicate the hook hands back.
 */

const windowLike = (over: Record<string, unknown>): unknown => {
  const stub: Record<string, unknown> = { ...over }
  stub['self'] = stub
  if (!('top' in over)) stub['top'] = stub
  return stub
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whether the folder control is offered', () => {
  it('is offered at the top level of an engine that has the picker', () => {
    vi.stubGlobal('window', windowLike({ showDirectoryPicker: () => {} }))
    expect(folderPickerSupported()).toBe(true)
  })

  it('is not offered in a frame, even though the picker is right there to probe', () => {
    vi.stubGlobal('window', windowLike({ showDirectoryPicker: () => {}, top: { name: 'the shell' } }))
    expect(folderPickerSupported(), 'the pick is refused in a frame, so the control cannot be the way it is found out').toBe(false)
  })

  it('is not offered on an engine with no picker, which is the older question this asked', () => {
    vi.stubGlobal('window', windowLike({}))
    expect(folderPickerSupported()).toBe(false)
  })
})
