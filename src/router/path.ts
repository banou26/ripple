export enum Route {
  HOME = 'HOME',
  ADD = 'ADD',
  EMBED = 'EMBED',
  LEGAL = 'LEGAL',
  PRIVACY = 'PRIVACY'
}

/**
 * What /embed accepts.
 *
 * `mode` picks the page: absent or `watch` is the player, `download` is the download page. `files`
 * is the download page's selection (`all`, `3`, `0-4`, `0,2,5`); `fileIndex` still names the single
 * file the player opens, and the download page falls back to it so that adding `&mode=download` to
 * an existing watch URL downloads what that URL was playing.
 *
 * The torrent arrives as either `m` (the packed form, see magnet-codec) or `magnet` (base64 of the
 * magnet URI, which is what README publishes and what every link written before the packed form
 * exists still carries). Both are read; only the shorter one is ever written.
 *
 * Nothing else. A link ASKS for a torrent and for files within it; it never describes them. It used
 * to carry `f`, a compressed copy of the file list for the download page to draw before metadata
 * arrived, which meant a second list that could be shown and never acted on, and on a single-file
 * release cost 38 per cent of the URL to add a file extension.
 */
/**
 * What /add accepts, which is deliberately almost nothing.
 *
 * A magnet, and optionally a name for the case where the magnet carries no `dn`. Nothing that
 * changes what happens: the page's whole job is to show a person what a stranger is proposing and
 * wait for them, so a parameter that could pre-agree to anything would defeat it.
 */
type AddOptions = { magnet: string, name?: string }

type EmbedSource = { magnet: string } | { m: string } | { torrentFile: string }
type EmbedOptions = EmbedSource & { fileIndex?: string, mode?: 'watch' | 'download', files?: string, f?: string }

/**
 * What the library page accepts, which is one torrent to open when it loads.
 *
 * `torrent` is an INFO HASH rather than a row id. A row id is a libtorrent handle, which is a counter
 * inside one session and names a different torrent in the next one, so a link carrying one would open
 * whatever the engine happened to assign that number to by the time somebody clicked it.
 *
 * Written by the embedded player, so a viewer watching a release inside somebody else's page has a
 * way back to the whole torrent in Ripple itself.
 */
type HomeOptions = { torrent?: string }

const Routes = {
  [Route.HOME]: (options?: HomeOptions) =>
    (options?.torrent ? `/?${new URLSearchParams({ torrent: options.torrent }).toString()}` : '/'),
  [Route.ADD]: (options: AddOptions) => `/add?${new URLSearchParams(options).toString()}`,
  [Route.EMBED]: (options: EmbedOptions) => `/embed?${new URLSearchParams(options).toString()}`,
  [Route.LEGAL]: () => '/legal',
  [Route.PRIVACY]: () => '/privacy'
} as const

const RouterRoutes = {
  [Route.HOME]: '/',
  [Route.ADD]: '/add',
  [Route.EMBED]: '/embed',
  [Route.LEGAL]: '/legal',
  [Route.PRIVACY]: '/privacy'
} as const

export const getRouterRoutePath = (route: Route) => RouterRoutes[route]

export const getRoutePath = <T extends Route>(route: T, args?: Parameters<(typeof Routes)[T]>[0]) =>
  Routes[route](args as any)
