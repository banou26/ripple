import { createMachine, interpret, spawn, send } from 'xstate'
import { assign } from 'xstate/lib/actions'


export const torrentMachine = createMachine({
  id: 'torrent',
  initial: 'offline',
  states: {
    offline: {
      on: {
        WAKE: 'online'
      }
    },
    online: {
      // after: {
      //   1000: {
      //     actions: sendParent('REMOTE.ONLINE')
      //   }
      // }
    }
  }
})
