export enum Route {
  HOME = 'HOME',
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
 */
type EmbedSource = { magnet: string } | { torrentFile: string }
type EmbedOptions = EmbedSource & { fileIndex?: string, mode?: 'watch' | 'download', files?: string }

const Routes = {
  [Route.HOME]: () => '/',
  [Route.EMBED]: (options: EmbedOptions) => `/embed?${new URLSearchParams(options).toString()}`,
  [Route.LEGAL]: () => '/legal',
  [Route.PRIVACY]: () => '/privacy'
} as const

const RouterRoutes = {
  [Route.HOME]: '/',
  [Route.EMBED]: '/embed',
  [Route.LEGAL]: '/legal',
  [Route.PRIVACY]: '/privacy'
} as const

export const getRouterRoutePath = (route: Route) => RouterRoutes[route]

export const getRoutePath = <T extends Route>(route: T, args?: Parameters<(typeof Routes)[T]>[0]) =>
  Routes[route](args as any)
