import type { ReactNode } from 'react'

import { css } from '@emotion/react'
import { Link } from 'react-router-dom'

import { getRoutePath, Route } from '../router/path'
import { HOVER_WASH, PAGE_BG, TEXT, TEXT_FAINT, TEXT_MUTED } from '../theme'

const style = css`
  position: relative;
  /* vh minus the strip the broker reserved, same contract as the library page. A bare 100vh here
     would still be a full viewport tall inside a root the reservation already shortened. */
  min-height: calc(100vh - var(--fkn-inset-top, 0px));
  background: ${PAGE_BG};
  /* Running prose sits a tier below the headings on purpose: h1 and h2 are TEXT, body copy is
     TEXT_MUTED (6.4:1 on the page, comfortably AA), and that gap is what leaves room for a link to
     step UP to TEXT instead of having nowhere brighter to go. */
  color: ${TEXT_MUTED};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  .shell {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 24px 72px;
  }

  /* The wordmark used to be painted by clipping a two stop brand fill to transparent glyphs, so its
     colour lived in a background and not in the colour property. It is a plain colour now, and it
     has to be one: this is the only route back to the home page from either document, and glyphs
     left transparent render as nothing at all, which strands the reader. Left undecorated, unlike
     the prose links below, because it is navigation rather than a reference inside a sentence. */
  .wordmark {
    display: inline-block;
    font-size: 1.5rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    color: ${TEXT};
    text-decoration: none;
    margin-bottom: 40px;
  }

  h1 {
    font-size: 2rem;
    font-weight: 900;
    color: ${TEXT};
    margin: 0 0 6px;
  }

  /* The quietest thing on the page and the only line that wants to be: a date nobody reads unless
     they are checking whether the terms moved. TEXT_FAINT rather than TEXT_MUTED keeps it below the
     body copy it sits above, and it is still 5.0:1 on the page. */
  .updated {
    font-size: 0.85rem;
    color: ${TEXT_FAINT};
    margin-bottom: 32px;
  }

  h2 {
    font-size: 1.15rem;
    font-weight: 800;
    color: ${TEXT};
    margin: 32px 0 10px;
  }

  p {
    font-size: 0.95rem;
    line-height: 1.7;
    margin: 0 0 10px;
  }

  /* Colour used to be the ONLY thing marking a link here (amber glyphs, no underline), and these two
     documents are dense with them: the platform link, the internal Privacy route, two mailtos. With
     hue gone that scheme collapses, because a brighter word inside a paragraph reads as emphasis,
     not as somewhere you can go. So the underline is the affordance now and it is not optional; the
     brightness step to TEXT is only there to back it up.

     Hover was a colour shift and can no longer be one, since TEXT is already the top of the scale
     and dimming a link under the cursor reads as it going away. A faint wash says the same thing
     without needing a value that does not exist. */
  a {
    color: ${TEXT};
    text-decoration: underline;

    &:hover {
      background: ${HOVER_WASH};
    }
  }
`

export const LegalDoc = ({ children }: { children: ReactNode }) => (
  <div css={style}>
    <div className="shell">
      <Link className="wordmark" to={getRoutePath(Route.HOME)}>Ripple</Link>
      {children}
    </div>
  </div>
)

export default LegalDoc
