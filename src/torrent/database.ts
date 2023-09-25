import { getLeaderElectorByBroadcastChannel } from 'rxdb/plugins/leader-election'
import { createRxDatabase } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'

import type { Collection as TorrentCollection } from './collection'

export type Collections = {
  torrents: TorrentCollection
}

export const database = await createRxDatabase<Collections>({
  name: 'ripple',
  storage: getRxStorageDexie()
})
export type Database = typeof database

const { broadcastChannel } = database.leaderElector()
const leaderElector = getLeaderElectorByBroadcastChannel(broadcastChannel)

export {
  leaderElector,
  broadcastChannel
}
