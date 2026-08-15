import { TORRENT_FLAG } from 'libtorrent-wasm'

import type { SaveLocation } from './library'

/**
 * What someone can decide about a torrent before it starts, and what those decisions turn into.
 *
 * The dialog that shows this is OFF by default for an ordinary add, because it is friction in front
 * of the common case where the answer is "yes, all of it, now". It is always shown for a torrent
 * arriving from another site through `/add`, and that is not the same setting under a different
 * name: a link on someone else's page is a proposal from a stranger, and agreeing to it is the whole
 * point of the step.
 *
 * A torrent has to be ADDED before any of this can be asked, because a magnet carries no file list
 * and the swarm is the only place to get one. So the flow is add, wait for metadata, hold, ask, then
 * apply. Nothing is downloaded in the meantime beyond the metadata itself, since a torrent with no
 * metadata has no pieces to ask for yet.
 *
 * No DOM and no engine here, so the rules can be tested on their own.
 */

export const ADD_DIALOG_KEY = 'ripple:add-dialog'

export type AddChoices = {
  /** File indices to download. Every other file is skipped. */
  files: number[]
  location: SaveLocation
  /** Off means it is added but held, which is qBittorrent's unticked "Start torrent". */
  start: boolean
  sequential: boolean
  /** qBittorrent's "Download first and last pieces first": the head and tail of each wanted file. */
  firstLast: boolean
  /** Jump the queue, for when something is wanted before whatever is already running. */
  topOfQueue: boolean
}

export const defaultChoices = (
  { fileCount, location }: { fileCount: number, location: SaveLocation },
): AddChoices => ({
  files: Array.from({ length: fileCount }, (_, i) => i),
  location,
  start: true,
  sequential: false,
  firstLast: false,
  topOfQueue: false,
})

/** Whether the dialog opens for an add the user made themselves. */
export const dialogEnabled = (read: (key: string) => string | null): boolean => {
  try { return read(ADD_DIALOG_KEY) === '1' } catch { return false }
}

/**
 * The download plan these choices imply, in the shape `client.setPlan` takes.
 *
 * `wanted` is left OUT when every file is selected, which is not the same as listing them all: the
 * absent form is what says "no selection", and it is the one that survives a torrent gaining files
 * it did not have when this was decided.
 */
export const planFor = (choices: AddChoices, fileCount: number): { wanted?: number[], firstLast?: boolean } => ({
  wanted: choices.files.length === fileCount ? undefined : [...choices.files].sort((a, b) => a - b),
  firstLast: choices.firstLast,
})

/** The libtorrent flags these choices imply, as a `[flags, mask]` pair for `setFlags`. */
export const flagsFor = (choices: AddChoices): [flags: number, mask: number] => [
  choices.sequential ? TORRENT_FLAG.sequentialDownload : 0,
  TORRENT_FLAG.sequentialDownload,
]

/**
 * Is this a usable set of choices?
 *
 * Selecting nothing is the one that has to be caught. libtorrent accepts a torrent with every file
 * skipped perfectly happily, and it then sits at 0% forever looking like a stalled download rather
 * than like a thing nobody asked for.
 */
export const choicesProblem = (choices: AddChoices): string | null =>
  choices.files.length === 0 ? 'Choose at least one file, or cancel to add nothing at all.' : null

/** Bytes that will actually be downloaded, which is what the dialog shows against the total. */
export const selectedBytes = (choices: AddChoices, files: { size: number }[]): number =>
  choices.files.reduce((total, index) => total + (files[index]?.size ?? 0), 0)

export const toggleFile = (choices: AddChoices, index: number): AddChoices => ({
  ...choices,
  files: choices.files.includes(index)
    ? choices.files.filter((i) => i !== index)
    : [...choices.files, index].sort((a, b) => a - b),
})

export const selectAll = (choices: AddChoices, fileCount: number): AddChoices =>
  ({ ...choices, files: Array.from({ length: fileCount }, (_, i) => i) })

export const selectNone = (choices: AddChoices): AddChoices => ({ ...choices, files: [] })
