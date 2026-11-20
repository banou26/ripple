import { Link } from 'react-router-dom'

import { getRoutePath, Route } from './path'
import LegalDoc from '../components/legal-doc'

const Legal = () => (
  <LegalDoc>
    <h1>Legal &amp; Terms</h1>
    <div className="updated">Last updated 20 November 2026</div>

    <p>
      Ripple is a torrent client that runs in your browser, built on the{' '}
      <a href="https://fkn.app" target="_blank" rel="noreferrer noopener">FKN platform</a>.
      It is provided &ldquo;as is&rdquo; without warranties of any kind.
    </p>

    <h2>No hosted content</h2>
    <p>
      Ripple hosts no torrents and no media. It has no search, no index, no tracker, and no
      catalog of its own. You supply the magnet links and .torrent files yourself, or through a
      plugin you added, and transfers happen between your browser and the other peers in each
      torrent&rsquo;s swarm. Downloaded data is stored only in your browser&rsquo;s storage, on
      your device.
    </p>

    <h2>Your content, your responsibility</h2>
    <p>
      Like any torrent client, while a transfer is active Ripple also uploads (seeds) the
      pieces you already have to other peers, which is a form of distribution. You are
      responsible for what you download and share. Only use Ripple with content you have
      the right to download and distribute.
    </p>

    <h2>Plugins</h2>
    <p>
      You can add plugins to Ripple. The plugins in FKN&rsquo;s package list, which shows packages
      published on npm, are published by others: Ripple and FKN do not write, review or endorse
      them, and are not responsible for what a plugin shows, finds, adds or does. Ripple keeps no
      list of its own. A plugin can use only what you turn on for it in Settings, and you can turn
      any of that off, or remove the plugin, at any time. You are responsible for the plugins you
      add and for the torrents they add for you, as for the ones you add yourself.
    </p>

    <h2>Rights holders</h2>
    <p>
      Ripple never hosts or indexes content, so there is nothing on our side to take down:
      what users transfer exists only in the torrent swarms they join and on their own
      devices. With the VPN on, peer traffic is forwarded through the FKN relay, which does
      not store content and does not keep logs that could link a transfer to a user
      afterwards (see the <Link to={getRoutePath(Route.PRIVACY)}>Privacy page</Link>). With
      the VPN off, peer traffic goes straight between your browser and the other peers and
      does not pass through FKN at all. A plugin that finds or adds torrents is published by its
      own publisher and runs in your browser, apart from Ripple. A concern about a plugin goes to
      its publisher. If you have a concern about the relay itself,
      contact{' '}
      <a href="mailto:admin@fkn.app">admin@fkn.app</a>.
    </p>

    <h2>Liability</h2>
    <p>
      Ripple is provided without warranty of any kind. FKN is not liable for any damages
      arising from its use, or for the content users choose to transfer with it.
    </p>
  </LegalDoc>
)

export default Legal
