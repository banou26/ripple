import type { RouteObject } from 'react-router-dom'

import { RouterProvider } from 'react-router'
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'

import Add from './add'
import Embed from './embed'
import Home from './home'
import Legal from './legal'
import Privacy from './privacy'
import { Hints } from '../components/hint'
import { shownLanguage, startLanguage, uiLanguage } from '../i18n'
import { useLeavePrompt } from './leave-prompt'
import { getRoutePath, getRouterRoutePath, Route } from './path'

const routes: RouteObject[] = [
  {
    path: getRouterRoutePath(Route.HOME),
    element: <Home/>
  },
  {
    path: getRouterRoutePath(Route.ADD),
    element: <Add/>
  },
  {
    path: getRouterRoutePath(Route.WATCH),
    element: <Embed/>
  },
  // The same component, told which page to be by the route rather than by a `mode` parameter. /watch
  // still reads that parameter, so every link published before this keeps landing where it did.
  {
    path: getRouterRoutePath(Route.DOWNLOAD),
    element: <Embed mode="download"/>
  },
  {
    path: getRouterRoutePath(Route.LEGAL),
    element: <Legal/>
  },
  {
    path: getRouterRoutePath(Route.PRIVACY),
    element: <Privacy/>
  },
  // Cloudflare Pages serves the app for every path, so an address the app does not know lands on the library
  {
    path: '*',
    element: <Navigate to={getRoutePath(Route.HOME)} replace/>
  }
]

/** Around every page, for what holds in the tab whichever one shows. */
const Pages = () => {
  useLeavePrompt()
  return <Outlet/>
}

const router = createBrowserRouter([{ element: <Pages/>, children: routes }])

// a link's language holds on /watch and /download alone, so a page reached from one in place shows the viewer's own
router.subscribe(() => { if (uiLanguage() !== shownLanguage()) void startLanguage() })

export const RouterMount = () => {
  return (
    <>
      <RouterProvider router={router}/>
      {/* One instance for every route, outside every scrolling and clipping container; see hint.tsx */}
      <Hints/>
    </>
  )
}
export default RouterMount
