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

  /*
   * The root gives back whatever the FKN broker reserves at the top of the viewport.
   *
   * Its docked header mode writes an important margin-top on this element plus a matching
   * --fkn-inset-top, and that variable is the app's half of the contract. Without it the margin is
   * added to a root that is already exactly as tall as the viewport, so the document grows by the
   * strip: a second scrollbar appears and the footer sits below the fold at rest.
   *
   * The fallback is 0px, which is every other mode and every page with no broker at all.
   *
   * No backticks in here. This is a css template literal, so one would end it.
   */
  html {
    margin: 0;
    height: calc(100% - var(--fkn-inset-top, 0px));
  }

  body {
    margin: 0;
    height: 100%;
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
