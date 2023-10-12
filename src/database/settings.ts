import type { RxCollection } from 'rxdb'

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

export const getSettingsDocument = async () => {
  const settings = await settingsCollection.findOne().exec()
  if (settings === null) {
    return settingsCollection.insert({})
  } else {
    return settings
  }
}
