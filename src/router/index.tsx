import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Add from './add'
import Embed from './embed'
import Home from './home'
import Legal from './legal'
import Privacy from './privacy'
import { Hints } from '../components/hint'
import { getRouterRoutePath, Route } from './path'

const router = createBrowserRouter([
  {
    path: getRouterRoutePath(Route.HOME),
    element: <Home/>
  },
  {
    path: getRouterRoutePath(Route.ADD),
    element: <Add/>
  },
  {
    path: getRouterRoutePath(Route.EMBED),
    element: <Embed/>
  },
  // The same component, told which page to be by the route rather than by a `mode` parameter. /embed
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
  }
])

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
