import type { Instance } from 'parse-torrent'

export type TorrentStatus =
  'paused' |
  'checking_files' |
  'downloading_metadata' |
  'downloading' |
  'finished' |
  'seeding'
// 'idle' | 'downloading' | 'paused' | 'seeding' | 'error'

export const torrentSchema = {
  title: 'Torrent schema',
  description: 'Describes a torrent',
  version: 0,
  primaryKey: 'infoHash',
  type: 'object',
  properties: {
    infoHash: {
      type: 'string',
      maxLength: 255
    },
    options: {
      type: 'object',
      properties: {
        proxy: {
          type: 'boolean'
        },
        p2p: {
          type: 'boolean'
        },
        paused: {
          type: 'boolean'
        }
      }
    },
    state: {
      type: 'object',
      properties: {
        magnet: {
          type: 'string',
          maxLength: 255
        },
        torrentFile: {
          type: 'object'
        },
        name: {
          type: 'string',
          maxLength: 255
        },
        status: {
          type: 'string',
          enum: [
            'paused',
            'checking_files',
            'downloading_metadata',
            'downloading',
            'finished',
            'seeding'
          ]
        },
        progress: {
          type: 'number'
        },
        size: {
          type: 'number'
        },
        peers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ip: {
                type: 'string',
                maxLength: 255
              },
              port: {
                type: 'number'
              }
            }
          }
        },
        addedAt: {
          type: 'number'
        },
        remainingTime: {
          type: 'number'
        },
        peersCount: {
          type: 'number'
        },
        seedersCount: {
          type: 'number'
        },
        leechersCount: {
          type: 'number'
        },
        downloaded: {
          type: 'number'
        },
        uploaded: {
          type: 'number'
        },
        downloadSpeed: {
          type: 'number'
        },
        uploadSpeed: {
          type: 'number'
        },
        ratio: {
          type: 'number'
        },
        path: {
          type: 'string',
          maxLength: 255
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                maxLength: 255
              },
              path: {
                type: 'string',
                maxLength: 255
              },
              offset: {
                type: 'number'
              },
              length: {
                type: 'number'
              },
              downloaded: {
                type: 'number'
              },
              progress: {
                type: 'number'
              },
              selected: {
                type: 'boolean'
              },
              priority: {
                type: 'number'
              }
            }
          }
        }
      }
    }
  },
  required: ['infoHash']
}

export type TorrentDocument = {
  infoHash: string
  options: {
    proxy: boolean
    p2p: boolean
    paused: boolean
  },
  state: {
    magnet?: string
    torrentFile?: Instance
    name: string
    status: TorrentStatus
    progress: number
    size: number
    peers: Array<{ ip: string, port: number }>
    addedAt: number
    remainingTime?: number
    peersCount?: number
    seedersCount?: number
    leechersCount?: number
    downloaded?: number
    uploaded?: number
    downloadSpeed?: number
    uploadSpeed?: number
    ratio?: number
    path?: string
    files?: Array<{
      name: string
      path: string
      offset: number
      length: number
      downloaded: number
      progress: number
      selected: boolean
      priority: number
    }>
  }
}