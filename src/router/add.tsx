import { Navigate, useSearchParams } from 'react-router-dom'

import { getRoutePath, Route } from './path'

/**
 * The address another site links to, which is a redirect and nothing else.
 *
 * It used to be a page of its own. It is better as a hand-off: the person lands in their library,
 * with everything they already have visible behind a dialog asking about the one new thing. That is
 * a place they recognise, and it makes "no" mean staying exactly where they are rather than being
 * dropped somewhere they have never seen.
 *
 * Nothing is decided here, deliberately, including whether the magnet is any good. Home validates
 * it, because a refusal belongs on the page they will end up on either way.
 *
 * `replace` so Back returns to the site that linked them, rather than to a redirect that would send
 * them straight forward again.
 */
const Add = () => {
  const [params] = useSearchParams()
  const magnet = params.get('magnet') ?? ''
  const name = params.get('name')
  const query = new URLSearchParams({ add: magnet, ...(name ? { addName: name } : {}) })
  return <Navigate to={`${getRoutePath(Route.HOME)}?${query.toString()}`} replace/>
}

export default Add
