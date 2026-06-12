export enum Route {
  HOME = 'HOME',
  EMBED = 'EMBED',
  LEGAL = 'LEGAL',
  PRIVACY = 'PRIVACY'
}

const Routes = {
  [Route.HOME]: () => '/',
  [Route.EMBED]: (options: { magnet: string, fileIndex?: string } | { torrentFile: string, fileIndex?: string }) => `/embed?${new URLSearchParams(options).toString()}`,
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
