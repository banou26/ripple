import { css } from '@emotion/react'
import { Switch, Route as WRoute } from 'wouter'

import Home from './home'
import Watch from './watch'
import Embed from './embed'
import FileHandler from './file-handler'
import ProtocolHandler from './protocol-handler'
import { getRouterRoutePath, Route } from './path'
import DropZone from '../components/drop-zone'

const contentStyle = css`
  padding-top: 6rem;
`

const wrapElement = (children: React.ReactNode) =>
  <DropZone>
    <div css={contentStyle}>
      {children}
    </div>
  </DropZone>

const RouterRoot = () =>(
  <Switch>
    <WRoute path={getRouterRoutePath(Route.HOME)} component={() => wrapElement(<Home/>)}/>
    <WRoute path={getRouterRoutePath(Route.WATCH)} component={() => <Watch/>}/>
    <WRoute path={getRouterRoutePath(Route.FILE_HANDLER)} component={() => <FileHandler/>}/>
    <WRoute path={getRouterRoutePath(Route.PROTOCOL_HANDLER)} component={() => wrapElement(<ProtocolHandler/>)}/>
    <WRoute component={() => wrapElement(<div>404 No page found</div>)}/>
  </Switch>
)
export default RouterRoot
