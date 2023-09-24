import { css } from '@emotion/react'
import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Home from './home'
import { getRouterRoutePath, Route } from './path'

const style = css`
`

const wrapElement = (children: React.ReactNode) =>
  <>
    <div css={style}>
      {children}
    </div>
  </>

const router = createBrowserRouter([
  {

    path: getRouterRoutePath(Route.HOME),
    element: wrapElement(<Home/>)
  },
  {
    path: '/*',
    element: wrapElement(<div>404 No page found</div>)
  }
])

export const RouterMount = () => <RouterProvider router={router}/>
export default RouterMount
