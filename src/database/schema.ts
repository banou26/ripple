import type { Instance } from 'parse-torrent'

export type TorrentStatus =
  'paused' |
  'checkingFiles' |
  'downloadingMetadata' |
  'downloading' |
  'finished' |
  'seeding'

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
          maxLength: 2**15
        },
        torrentFile: {
          type: 'object'
        },
        name: {
          type: 'string',
          maxLength: 2**11
        },
        status: {
          type: 'string',
          enum: [
            'paused',
            'checkingFiles',
            'downloadingMetadata',
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
        pieces: {
          type: 'array',
          items: {
            type: 'number'
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
              },
              downloadedRanges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: {
                      type: 'number'
                    },
                    end: {
                      type: 'number'
                    }
                  }
                }
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
    paused: boolean
  },
  state: {
    magnet?: string
    torrentFile?: Instance

    status: TorrentStatus
    progress: number
    addedAt: number

    name?: string
    size?: number
    peers: { ip: string, port: number }[]
    // 0 = not downloaded, 1 = downloaded, 2 = partially downloaded (in the case of a piece spanning multiple files)
    pieces?: number[]
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
    files?: {
      name: string
      path: string
      offset: number
      length: number
      downloaded: number
      progress: number
      selected: boolean
      priority: number
      downloadedRanges: {
        start: number
        end: number
      }[]
    }[]
  }
}
