import type { RxCollection } from 'rxdb'

import { database } from './database'
import { SettingsDocument, settingsSchema } from './schema'
import { useEffect, useState } from 'react'

const { settings } = await database.addCollections({
  settings: {
    schema: settingsSchema,

  }
}).catch(err => {
  if (import.meta.env.MODE !== 'development') throw err
  
  const res = indexedDB.deleteDatabase('rxdb-dexie-ripple--0--_rxdb_internal')
  res.onsuccess = () => {
    location.reload()
  }
  throw err
})

const settingsCollection = settings as unknown as RxCollection<SettingsDocument>

export type SettingsCollection = typeof settingsCollection
export {
  settingsCollection
}

const initialSettings = {
  id: 'settings',
  paused: false,
  throttle: 0,
  maxConnections: 0,
  downloadSpeedLimit: 10_000_000, // 20 MB/s
  downloadSpeedLimitEnabled: true,
  saveFolderHandle: undefined
}

export const useSettingsDocument = () => {
  const [settings, setSettings] = useState<SettingsDocument>()
  useEffect(() => {
    const subscription =
      settingsCollection
        .findOne({})
        .$
        .subscribe((doc) => setSettings(doc ?? undefined))
    return () => subscription.unsubscribe()
  }, [])

  return settings
}

export const getSettingsDocument = async () => (await settingsCollection.findOne().exec())

getSettingsDocument().then(settingsDocument => {
  if (settingsDocument) return
  settingsCollection.insert(initialSettings)
})
