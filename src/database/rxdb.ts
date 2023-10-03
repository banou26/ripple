import { addRxPlugin } from 'rxdb'
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election'
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder'
import { RxDBUpdatePlugin } from 'rxdb/plugins/update'
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode'

addRxPlugin(RxDBDevModePlugin)
addRxPlugin(RxDBUpdatePlugin)
addRxPlugin(RxDBQueryBuilderPlugin)
addRxPlugin(RxDBLeaderElectionPlugin)
