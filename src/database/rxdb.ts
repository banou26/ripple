import { addRxPlugin, createRxDatabase } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election'
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder'
import { RxDBUpdatePlugin } from 'rxdb/plugins/update'
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode'
import { RxDBMigrationPlugin } from 'rxdb/plugins/migration'
import { RxDBAttachmentsPlugin } from 'rxdb/plugins/attachments'

import { TorrentCollection } from './torrents'

const ENV = import.meta.env.MODE

if (ENV === 'development') addRxPlugin(RxDBDevModePlugin)

addRxPlugin(RxDBAttachmentsPlugin)
addRxPlugin(RxDBUpdatePlugin)
addRxPlugin(RxDBQueryBuilderPlugin)
addRxPlugin(RxDBLeaderElectionPlugin)
addRxPlugin(RxDBMigrationPlugin)

export type Collections = {
    torrents: TorrentCollection
}

export const database = await createRxDatabase<Collections>({
    name: 'ripple',
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true
})
