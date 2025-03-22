import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Embed from './embed'
import { getRouterRoutePath, Route } from './path'

const router = createBrowserRouter([

  {
    path: getRouterRoutePath(Route.EMBED),
    element: <Embed/>
  }
])

export const RouterMount = () => <RouterProvider router={router}/>
export default RouterMount
