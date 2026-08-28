import { useCallback, useEffect, useRef, useState } from 'react'

import { shell } from '@fkn/lib'

import { getTorrentClient } from './client'
import { interrupts } from './shell-update'
import { snapshotState } from './use-torrents'
import { reloadPage } from '../utils/reload'

/**
 * Decide what an FKN shell update does to this page.
 *
 * `@fkn/lib` reloads the page by default when somebody takes an update, and it reaches EVERY open
 * page rather than only the one where the button was pressed: activating the new shell claims every
 * client on the origin. For most apps that default is right, because the alternative is a tab
 * running a new worker against a document from the old build.
 *
 * For ripple it is the one thing not to do. A reload terminates the engine worker, and the person
 * who pressed update was quite possibly in a different tab, with a download running here that they
 * were not thinking about. Registering a handler replaces the default entirely, so from here on
 * nothing reloads this page unless this file says so.
 *
 * Nothing is lost either way, since progress is in OPFS and a torrent resumes. What is avoided is
 * the interruption, which is what the person actually notices.
 *
 * The banner is deliberately not a toast. A toast that carries the only way to finish an update
 * would take it away again after a few seconds.
 */
export type ShellUpdate = {
  /** An update was taken elsewhere and this page is holding off because it is busy. */
  pending: boolean
  /** Take it now. */
  reload: () => void
}

export const useShellUpdate = (): ShellUpdate => {
  const [pending, setPending] = useState(false)
  /**
   * The live engine state, in a ref rather than in React state.
   *
   * The handler is registered once and must see the list as it is at the moment update is pressed,
   * which can be minutes later. Closing over a render's value would ask a question about the past,
   * and re-registering on every state change would churn a broker subscription several times a
   * second while anything is downloading.
   */
  const busy = useRef(false)

  useEffect(() => {
    const client = getTorrentClient()
    return client.onState((snapshots) => { busy.current = interrupts(snapshots.map(snapshotState)) })
  }, [])

  useEffect(() => {
    // registering AT ALL is what suppresses the lib's own reload, so this runs whether or not the
    // page turns out to be busy: the choice has to be ours in both directions
    const off = shell.onUpdateTaken(() => {
      if (busy.current) { setPending(true); return }
      // nothing running, so finish the update now rather than leaving a banner nobody needs
      reloadPage()
    })
    return off
  }, [])

  const reload = useCallback(() => { reloadPage() }, [])

  return { pending, reload }
}
