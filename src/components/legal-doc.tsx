import type { ReactNode } from 'react'

import { css } from '@emotion/react'
import { Link } from 'react-router-dom'

import { getRoutePath, Route } from '../router/path'

const style = css`
  position: relative;
  min-height: 100vh;
  background: radial-gradient(1100px 500px at 75% -5%, #2b1f3f 0%, transparent 60%), #16131c;
  color: #b6b0c4;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  .shell {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 24px 72px;
  }

  .wordmark {
    display: inline-block;
    font-size: 1.5rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    background: linear-gradient(90deg, #fbbf24, #f97316);
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    text-decoration: none;
    margin-bottom: 40px;
  }

  h1 {
    font-size: 2rem;
    font-weight: 900;
    color: #f4f2f8;
    margin: 0 0 6px;
  }

  .updated {
    font-size: 0.85rem;
    color: #8b8499;
    margin-bottom: 32px;
  }

  h2 {
    font-size: 1.15rem;
    font-weight: 800;
    color: #f4f2f8;
    margin: 32px 0 10px;
  }

  p {
    font-size: 0.95rem;
    line-height: 1.7;
    margin: 0 0 10px;
  }

  a {
    color: #fbbf24;
    text-decoration: none;

    &:hover {
      color: #f97316;
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
