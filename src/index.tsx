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

/**
 * The worker makes the app installable, which is what lets the OS route .torrent files and magnet
 * links to it, and it is also the thing every download is written through: `openStreamSink` needs a
 * controller on this page or a save falls back to the picker.
 *
 * `updateViaCache: 'none'` rather than a `_headers` rule, because Cloudflare Pages is known to
 * override cache-control on worker paths, and this option needs nobody's cooperation: the browser
 * skips its own HTTP cache for the script on the first fetch and on every update check.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
  })
}
