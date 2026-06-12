import './torrent/node-shims'

import { css, Global } from '@emotion/react'
import { createRoot } from 'react-dom/client'

import Mount from './components/mount'

const style = css`
  :root {
    color-scheme: dark;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  html, body {
    margin: 0;
    height: 100%;
  }

  body {
    background: #16131c;
    color: #f4f2f8;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  body > .mount {
    height: 100%;
  }
`

const rootElem = document.body.appendChild(document.createElement('div'))
rootElem.classList.add('mount')
const root = createRoot(rootElem)

root.render(
  <>
    <Global styles={style}/>
    <Mount/>
  </>
)
