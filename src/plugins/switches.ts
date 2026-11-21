import type { Button, Switch } from './contract'

import { useSyncExternalStore } from 'react'
import { del, get, update } from 'idb-keyval'

/** The switches this version of ripple offers. A plugin asking for another one is not asked about it yet. */
export const OFFERED_SWITCHES: readonly Switch[] = ['read', 'add', 'change', 'remove', 'files', 'folder', 'peers', 'network']

/** Each plugin's answers by its uri: a switch present was answered, on or off. Absent means never asked. */
export type Answers = Partial<Record<Switch, boolean>>
type Stored = Record<string, Answers>

export const SWITCHES_KEY = 'ripple:plugin-switches'
/** Each plugin's buttons by its uri, as every tab draws them. */
export const BUTTONS_KEY = 'ripple:plugin-buttons'
const CHANNEL = 'ripple:plugins'

/** A plugin's buttons by language, with the name and install time fkn.app gave it, which order and label them. */
export type KeptButtons = { name: string, installedAt: number, locales: Record<string, Button[]> }

export const storeKey = (uri: string) => 'ripple:plugin-store:' + uri

let shown: Stored | undefined
let buttons: Record<string, KeptButtons> | undefined
const listeners = new Set<() => void>()
let channel: BroadcastChannel | undefined

const reread = async () => {
  ;[shown, buttons] = await Promise.all([
    get<Stored>(SWITCHES_KEY).catch(() => undefined).then((held) => held ?? {}),
    get<Record<string, KeptButtons>>(BUTTONS_KEY).catch(() => undefined).then((held) => held ?? {}),
  ])
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
export const announce = async () => {
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

/** Every plugin's kept buttons, undefined until read. */
export const useKeptButtons = (): Record<string, KeptButtons> | undefined => useSyncExternalStore(subscribeAnswers, () => buttons)

/** What `uri`'s buttons were kept as. */
export const keptButtons = async (uri: string): Promise<KeptButtons | undefined> =>
  (await get<Record<string, KeptButtons>>(BUTTONS_KEY).catch(() => undefined))?.[uri]

/** Keeps `uri`'s buttons, and tells every tab. */
export const keepButtons = async (uri: string, kept: KeptButtons): Promise<void> => {
  await update<Record<string, KeptButtons>>(BUTTONS_KEY, (held) => ({ ...held, [uri]: kept }))
  await announce()
}

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

const without = <T>(uri: string) => (held: Record<string, T> | undefined) => {
  const { [uri]: _gone, ...rest } = held ?? {}
  return rest
}

/** Deletes everything ripple keeps for `uri`: its answers, its store and its buttons. */
export const forget = async (uri: string): Promise<void> => {
  await update<Stored>(SWITCHES_KEY, without(uri))
  await update<Record<string, KeptButtons>>(BUTTONS_KEY, without(uri))
  await del(storeKey(uri)).catch(() => {})
  await announce()
}
