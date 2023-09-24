import { addRxPlugin } from 'rxdb'
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election'

addRxPlugin(RxDBLeaderElectionPlugin)
