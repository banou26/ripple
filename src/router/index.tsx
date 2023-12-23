import { css } from '@emotion/react'
import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Embed from './embed'
import FileHandler from './file-handler'
import ProtocolHandler from './protocol-handler'
import { getRouterRoutePath, Route } from './path'
import DropZone from '../components/drop-zone'

const style = css`
`

const wrapElement = (children: React.ReactNode) =>
  <DropZone>
    {children}
  </DropZone>

const router = createBrowserRouter([
  {

    path: getRouterRoutePath(Route.HOME),
    lazy: async () => {
      const { Home } = await import('./home')
      return {
        element: wrapElement(<Home/>)
      }
    }
  },
  {
    path: getRouterRoutePath(Route.WATCH),
    lazy: async () => {
      const { Watch } = await import('./watch')
      return {
        element: wrapElement(<Watch/>)
      }
    }
  },
  {
    path: getRouterRoutePath(Route.EMBED),
    element: <Embed/>
  },
  {
    path: getRouterRoutePath(Route.FILE_HANDLER),
    element: wrapElement(<FileHandler/>)
  },  {
    path: getRouterRoutePath(Route.PROTOCOL_HANDLER),
    element: wrapElement(<ProtocolHandler/>)
  },
  {
    path: '/*',
    element: wrapElement(<div>404 No page found</div>)
  }
])

export const RouterMount = () => <RouterProvider router={router}/>
export default RouterMount
