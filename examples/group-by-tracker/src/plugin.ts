import type { Button, ClickContext, PluginTorrent, Ripple, RipplePlugin } from '@banou/ripple'

// a tag, drawn by ripple in its own text colour, so the colour here does not matter
const ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">'
  + '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
)}`

const WORDS = {
  en: { all: 'Group by tracker', one: 'Put in its tracker\'s group', auto: 'Group new torrents', stop: 'Stop grouping new torrents' },
  fr: { all: 'Grouper par tracker', one: 'Mettre dans le groupe de son tracker', auto: 'Grouper les nouveaux torrents', stop: 'Ne plus grouper les nouveaux torrents' },
}
const wordsIn = (locale: string) => WORDS[locale.split('-')[0] as keyof typeof WORDS] ?? WORDS.en

/** A torrent's group: its first tracker's host. A torrent with no tracker has none. */
const groupOf = (torrent: PluginTorrent) => (torrent.trackers[0] ? new URL(torrent.trackers[0]).hostname : null)

/**
 * The plugin one ripple tab connects to: a header button that puts every torrent in a group named after its tracker,
 * the same for one torrent in its menu, and a Settings button that does it for each torrent added from then on.
 */
export const createPlugin = (connected: Promise<Ripple>): RipplePlugin => {
  const grouped = async (torrents: PluginTorrent[]) => {
    const ripple = await connected
    const groups = await ripple.groups()
    const byGroup = new Map<string, string[]>()
    for (const torrent of torrents) {
      const name = groupOf(torrent)
      if (name) byGroup.set(name, [...(byGroup.get(name) ?? []), torrent.infoHash])
    }
    for (const [name, infoHashes] of byGroup) {
      const group = groups.find((one) => one.name === name)
      if (group) await ripple.putInGroup(group.id, infoHashes)
      else await ripple.createGroup(name, infoHashes)
    }
  }

  const automatic = async () => (await (await connected).store.get('automatic')) === 'on'

  // `added` fires only in the tab running the engine, so each new torrent is grouped once; it needs the read switch,
  // so a refusal is tried again on the next click. A call in flight when ripple's tab closes rejects, and is let go.
  let listening: Promise<unknown> | null = null
  const listen = () => {
    listening ??= connected
      .then((ripple) => ripple.on('added', (torrent) => {
        void automatic().then((on) => (on ? grouped([torrent]) : undefined)).catch(() => {})
      }))
      .catch(() => { listening = null })
  }
  listen()

  return {
    asks: ['read', 'change'],
    buttons: async (locale): Promise<Button[]> => {
      const words = wordsIn(locale)
      return [
        { id: 'all', place: 'header', label: words.all, icon: ICON },
        { id: 'one', place: 'row-menu', label: words.one },
        { id: 'automatic', place: 'settings', label: (await automatic()) ? words.stop : words.auto, icon: ICON },
      ]
    },
    click: async (id: string, context: ClickContext) => {
      const ripple = await connected
      listen()
      if (id === 'all') await grouped(await ripple.torrents())
      if (id === 'one') {
        const torrents = await Promise.all((context.infoHashes ?? []).map((infoHash) => ripple.torrent(infoHash)))
        await grouped(torrents.filter((torrent) => torrent !== null))
      }
      if (id === 'automatic') {
        await ripple.store.set('automatic', (await automatic()) ? null : 'on')
        await ripple.ui.buttonsChanged()
      }
    },
  }
}
