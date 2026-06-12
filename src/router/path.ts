export enum Route {
  HOME = 'HOME',
  EMBED = 'EMBED'
}

const Routes = {
  [Route.HOME]: () => '/',
  [Route.EMBED]: (options: { magnet: string, fileIndex?: string } | { torrentFile: string, fileIndex?: string }) => `/embed?${new URLSearchParams(options).toString()}`
} as const

const RouterRoutes = {
  [Route.HOME]: '/',
  [Route.EMBED]: '/embed'
} as const

export const getRouterRoutePath = (route: Route) => RouterRoutes[route]

export const getRoutePath = <T extends Route>(route: T, args?: Parameters<(typeof Routes)[T]>[0]) =>
  Routes[route](args as any)
