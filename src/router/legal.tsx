import { Link } from 'react-router-dom'

import { getRoutePath, Route } from './path'
import LegalDoc from '../components/legal-doc'

const Legal = () => (
  <LegalDoc>
    <h1>Legal &amp; Terms</h1>
    <div className="updated">Last updated 12 June 2026</div>

    <p>
      Ripple is a torrent client that runs in your browser, built on the{' '}
      <a href="https://fkn.app" target="_blank" rel="noreferrer noopener">FKN platform</a>.
      It is provided &ldquo;as is&rdquo; without warranties of any kind.
    </p>

    <h2>No hosted content</h2>
    <p>
      Ripple hosts no torrents and no media. It has no search, no index, no tracker, and no
      catalog of any kind. You supply the magnet links and .torrent files yourself, and
      transfers happen between your browser and the other peers in each torrent&rsquo;s
      swarm. Downloaded data is stored only in your browser&rsquo;s storage, on your device.
    </p>

    <h2>Your content, your responsibility</h2>
    <p>
      Like any torrent client, while a transfer is active Ripple also uploads (seeds) the
      pieces you already have to other peers, which is a form of distribution. You are
      responsible for what you download and share. Only use Ripple with content you have
      the right to download and distribute.
    </p>

    <h2>Rights holders</h2>
    <p>
      Ripple never hosts or indexes content, so there is nothing on our side to take down:
      what users transfer exists only in the torrent swarms they join and on their own
      devices. Peer traffic is forwarded through the FKN relay, which does not store
      content and does not keep logs that could link a transfer to a user afterwards (see
      the <Link to={getRoutePath(Route.PRIVACY)}>Privacy page</Link>). If you have a
      concern about abuse of the relay itself, contact{' '}
      <a href="mailto:contact@fkn.app">contact@fkn.app</a>.
    </p>

    <h2>Liability</h2>
    <p>
      Ripple is provided without warranty of any kind. FKN is not liable for any damages
      arising from its use, or for the content users choose to transfer with it.
    </p>
  </LegalDoc>
)

export default Legal
