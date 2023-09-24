import type { RxDatabase, RxCollection, RxJsonSchema, RxDocument } from 'rxdb'

type TorrentStatus =
  'checking_files' |
  'downloading_metadata' |
  'downloading' |
  'finished' |
  'seeding' |
  'unused_enum_for_backwards_compatibility_allocating' |
  'checking_resume_data'
// 'idle' | 'downloading' | 'paused' | 'seeding' | 'error'

export type Torrent = {
  xt: string
  magnet: string
  name?: string

}

export type Collection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type TorrentDocType = Omit<Torrent, '__typename' | 'handles'> & { handles: [] }

export type TorrentDocMethods = {
  // scream: (v: string) => string
}

export type TorrentDocument = RxDocument<TorrentDocType, TorrentDocMethods>

export type TorrentCollectionMethods = {
  countAllDocuments: () => Promise<number>
}

export type TorrentCollection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type MyDatabaseCollections = {
  torrents: TorrentCollection
}

export type TorrentDB = RxDatabase<MyDatabaseCollections>
// magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com
const torrentSchema: RxJsonSchema<TorrentDocType> = {
  title: 'Torrent schema',
  description: 'Describes a torrent',
  version: 0,
  xt: 'uri',
  type: 'object',
  properties: {
    xt: {
      type: 'string',
      maxLength: 255
    },
    magnet: { type: 'string' },
    name: { type: 'string' },
    torrentFile: { type: 'string' },
  },
  required: ['xt', 'magnet']
}

const torrentDocMethods: TorrentDocMethods = {
  // scream: function(this: TorrentDocument, what: string) {
  //   return this.id + ' screams: ' + what.toUpperCase()
  // }
}

const torrentCollectionMethods: TorrentCollectionMethods = {
  countAllDocuments: async function(this: TorrentCollection) {
    return (await this.find().exec()).length
  }
}

// await database.addCollections({
//   torrents: {
//     schema: torrentSchema,
//     methods: torrentDocMethods,
//     statics: torrentCollectionMethods
//   }
// })

export const addTorrent = async (pkg: TorrentDocType) => {
  // await database.torrents.insert(pkg)
}
