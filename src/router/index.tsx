import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Embed from './embed'
import Home from './home'
import { getRouterRoutePath, Route } from './path'

const router = createBrowserRouter([
  {
    path: getRouterRoutePath(Route.HOME),
    element: <Home/>
  },
  {
    path: getRouterRoutePath(Route.EMBED),
    element: <Embed/>
  }
])

export const RouterMount = () => {
  return <RouterProvider router={router}/>
}
export default RouterMount
