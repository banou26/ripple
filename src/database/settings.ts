import type { RxCollection } from 'rxdb'

import { useRxCollection, useRxQuery } from 'rxdb-hooks'

import { database } from './database'
import { SettingsDocument, settingsSchema } from './schema'


const { settings } = await database.addCollections({
  settings: {
    schema: settingsSchema
  }
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
  maxDownloadSpeed: 0
}

export const useSettingsDocument = () => {
  const collection = useRxCollection<SettingsDocument>('settings')
  const downloadingTorrentQuery = collection?.find({ selector: { id: 'settings' } })
  const { result: settingsDocument } = useRxQuery(downloadingTorrentQuery)
  return settingsDocument[0]
}

export const getSettingsDocument = async () => (await settingsCollection.findOne().exec())

getSettingsDocument().then(settingsDocument => {
  if (settingsDocument) return
  settingsCollection.insert(initialSettings)
})
