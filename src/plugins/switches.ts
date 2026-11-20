import type { Switch } from './contract'

import { useSyncExternalStore } from 'react'
import { del, get, update } from 'idb-keyval'

/** Each plugin's answers by its uri: a switch present was answered, on or off. Absent means never asked. */
export type Answers = Partial<Record<Switch, boolean>>
type Stored = Record<string, Answers>

export const SWITCHES_KEY = 'ripple:plugin-switches'
const CHANNEL = 'ripple:plugins'

export const storeKey = (uri: string) => 'ripple:plugin-store:' + uri

let shown: Stored | undefined
const listeners = new Set<() => void>()
let channel: BroadcastChannel | undefined

const reread = async () => {
  shown = (await get<Stored>(SWITCHES_KEY).catch(() => undefined)) ?? {}
  for (const listener of listeners) listener()
}

const channelOf = () => {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = () => { void reread() }
  }
  return channel
}

// a BroadcastChannel never delivers to the object that posted, so this tab's own change is read here
const announce = async () => {
  channelOf().postMessage(null)
  await reread()
}

/** Calls `listener` whenever any plugin's answers may have changed, in this tab or another. */
export const subscribeAnswers = (listener: () => void): (() => void) => {
  channelOf()
  listeners.add(listener)
  if (listeners.size === 1) void reread()
  return () => { listeners.delete(listener) }
}

/** Every plugin's answers, undefined until read. */
export const useAnswers = (): Stored | undefined => useSyncExternalStore(subscribeAnswers, () => shown)

/** What the person answered for `uri`, read from storage on every call. Undefined for a plugin with no answers. */
export const answersOf = async (uri: string): Promise<Answers | undefined> =>
  (await get<Stored>(SWITCHES_KEY).catch(() => undefined))?.[uri]

/** Whether `uri`'s switch is on, read from storage on every call. */
export const isOn = async (uri: string, name: Switch): Promise<boolean> => (await answersOf(uri))?.[name] === true

/** The plugins answered for on this device. */
export const answeredUris = async (): Promise<string[]> =>
  Object.keys((await get<Stored>(SWITCHES_KEY).catch(() => undefined)) ?? {})

/** Whether any plugin was ever answered for on this device. */
export const anyPlugin = async (): Promise<boolean> => (await answeredUris()).length > 0

/** Records `answers` over what `uri` had, in one transaction, and tells every tab. */
export const answer = async (uri: string, answers: Answers): Promise<void> => {
  await update<Stored>(SWITCHES_KEY, (stored) => ({ ...stored, [uri]: { ...stored?.[uri], ...answers } }))
  await announce()
}

/** Deletes everything ripple keeps for `uri`: its answers and its store. */
export const forget = async (uri: string): Promise<void> => {
  await update<Stored>(SWITCHES_KEY, (stored) => {
    const { [uri]: _gone, ...rest } = stored ?? {}
    return rest
  })
  await del(storeKey(uri)).catch(() => {})
  await announce()
}
