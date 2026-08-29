import { useEffect } from 'react'

import { shell } from '@fkn/lib'

import { reloadPage } from '../utils/reload'

/**
 * Reload this page when somebody takes an FKN shell update.
 *
 * The update reaches EVERY open page rather than only the one where the button was pressed:
 * activating the new shell claims every client on the origin. Taking it everywhere is the point, so
 * that no tab is left running a document from the old build against the new shell around it.
 *
 * A handler is registered rather than left to `@fkn/lib`'s own default, which is also a reload:
 * registering is what makes the choice ours, `reloadPage` is guarded against a frame that refuses
 * navigation, and a test can see this happen where it cannot see the lib's.
 *
 * This USED to hold off while a torrent was running and offer a banner instead. It no longer does.
 * Nothing is lost by reloading: progress is in OPFS and a torrent resumes on its own. The one thing
 * that does not survive is a save-to-disk export mid-write, which stops with a partial file the
 * person can start again.
 */
export const useShellUpdate = (): void => {
  useEffect(() => shell.onUpdateTaken(() => { reloadPage() }), [])
}
