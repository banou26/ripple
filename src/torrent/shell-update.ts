import type { TorrentState } from './types'

/**
 * Would reloading this page right now interrupt something?
 *
 * Asked when somebody takes an FKN shell update. `@fkn/lib` reloads the page by default, which is
 * the right answer for most apps and the wrong one for this one: a reload terminates the engine
 * worker, and the person who pressed update may have been in another tab entirely, with a transfer
 * running here they were not thinking about.
 *
 * Split out from the hook so the judgement can be tested without a broker, an engine, or a
 * navigation, which is what the real thing ends in.
 */

/**
 * States where a reload costs nothing, listed rather than their opposite ON PURPOSE.
 *
 * The set has to fail safe, and the two directions are not symmetrical: staying on the old shell
 * until the person reloads costs them nothing they will notice, while reloading over a live
 * transfer costs them the thing they came here to do. So anything NOT named here counts as busy,
 * and a state added to the engine later is treated as work until somebody decides otherwise.
 */
const IDLE: readonly TorrentState[] = ['paused', 'queued', 'done', 'error', 'missing']

export const isIdle = (state: TorrentState): boolean => IDLE.includes(state)

/** True when at least one torrent is doing something a reload would cut off. */
export const interrupts = (states: readonly TorrentState[]): boolean =>
  states.some((state) => !isIdle(state))
