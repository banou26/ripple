import type { ActorRefFrom } from 'xstate'

import type { TorrentMachine } from './torrent'

import { createMachine } from 'xstate'

import { TorrentDocument } from '../database'

export const fileMachine = createMachine({
  id: 'torrentFile',
  initial: 'checkingFile',
  context: <T extends ActorRefFrom<TorrentMachine>>({ input }: { input: { parent: T, document: TorrentDocument } }) => console.log('File input', input) || ({
    parent: input.parent as unknown as ActorRefFrom<TorrentMachine>,
    document: input.document,
    file: input.document.state.files
  }),
  states: {
    checkingFile: {
      on: {
        'READY': 'downloading'
      },
      // parent: {
      //   invoke: [{
          
      //   }]
      // }
    },
    downloading: {
      on: {
        'FILES.FINISHED': 'finished',
        'TORRENT.PAUSE': 'paused'
      }
    },
    paused: {
      on: {
        'TORRENT.RESUME': 'downloading'
      }
    },
    finished: {
      
    }
  }
})

export type FileMachine = typeof fileMachine

