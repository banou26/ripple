import LegalDoc from '../components/legal-doc'
import { STUN_HOST, TRACKER_HOSTS } from '../torrent/vpn-config'

const Privacy = () => (
  <LegalDoc>
    <h1>Privacy</h1>
    <div className="updated">Last updated 17 November 2026</div>

    <p>
      Ripple needs no account and runs no analytics. Used without an account, it keeps
      everything on your device, and neither Ripple nor FKN stores anything about you on a
      server.
    </p>

    <h2>What Ripple stores on your device</h2>
    <p>
      Your torrent list and its groups, each torrent&rsquo;s resume data, .torrent file and
      thumbnail, and your settings (such as speed limits, how the list is sorted and whether
      the VPN is on) live in your browser&rsquo;s storage
      (IndexedDB and local storage). Downloaded files live in your browser&rsquo;s storage
      (OPFS). If you choose a folder on your disk, finished downloads are saved there. Once
      you sign in, Ripple also remembers which FKN account your list and groups belong to.
    </p>
    <p>
      Ripple never stores your files on FKN or on any server. Like any BitTorrent app, while a
      torrent is active it shares the pieces it has with the other peers of that torrent.
    </p>

    <h2>Library sync when signed in</h2>
    <p>
      If you connect an FKN account, Ripple keeps a copy of your library in that
      account&rsquo;s FKN cloud storage, so it follows you across devices. For each torrent
      that is its magnet link, name, size and file list, where it is saved, when you added it,
      and its totals (data downloaded and uploaded, time active and seeding). It also keeps the
      torrents you removed and when, so other devices remove them too, your groups (each
      group&rsquo;s name, and which torrents were put in it or taken out and when), and one
      thumbnail picture per torrent. Each torrent&rsquo;s .torrent file syncs too, with its
      tracker addresses. It never syncs the downloaded files themselves.
    </p>
    <p>
      All of it is encrypted in your browser before it is uploaded, so FKN stores it without
      being able to read it. File names stay visible to FKN, but they do not say which
      torrents you have. Without an account connected, nothing is synced.
    </p>

    <h2>Group links</h2>
    <p>
      A group&rsquo;s link holds the group&rsquo;s name and, for each of its torrents, its magnet
      link without its name: the info hash, trackers and web seeds. All of it is after the # in
      the address, a part browsers never send to a server, so opening the link shows the server a
      visit to /add and nothing of the group. A torrent added on this device from a .torrent file
      marked private is left out. Like any link, it stays wherever you paste it, and whoever has it
      can read it.
    </p>

    <h2>The VPN and your IP address</h2>
    <p>
      With the VPN on, which is how Ripple starts, connections to peers and to trackers are
      tunneled through the FKN relay rather than opened directly, so the other peers in a
      swarm and its trackers see the relay&rsquo;s IP address, not yours. The relay also looks
      up the names of trackers. It forwards traffic without storing it. Usage metering for the
      free and premium tiers is anonymized with daily-rotating keys and purged within about a
      day, so past transfers cannot be mapped back to a person, by us or anyone else. The full
      details are in the{' '}
      <a href="https://fkn.app/privacy" target="_blank" rel="noreferrer noopener">
        FKN platform privacy policy
      </a>.
    </p>
    <p>
      With the VPN off, Ripple connects to peers straight from your browser, and nothing
      passes through the FKN relay. Your IP address is then seen by:
    </p>
    <ul data-testid="vpn-off-hosts">
      <li>the other peers of each torrent that is running;</li>
      <li>
        the trackers Ripple announces those torrents to: {TRACKER_HOSTS.join(' and ')}, and any
        WebSocket tracker a torrent names itself. A tracker also sees which torrents they are.
        A torrent marked private is announced to its own trackers only, once Ripple has read
        that mark;
      </li>
      <li>{STUN_HOST}, which tells your browser its public address and sees nothing about your torrents;</li>
      <li>the name server your device uses, which is asked for the addresses of those hosts as it is for any site.</li>
    </ul>
    <p>
      The VPN setting is kept in your browser&rsquo;s storage. A player embedded in another
      site keeps its own.
    </p>

    <h2>Your control</h2>
    <p>
      Removing a torrent deletes its data from your browser&rsquo;s storage. Files in a folder
      on your disk, and the files you made a torrent from, stay where they are. Clearing this
      site&rsquo;s data in your browser removes everything Ripple stored in your browser.
    </p>
    <p>
      Ripple itself has no account to delete. Disconnecting your FKN account stops the sync.
      Removing a torrent also removes it from the synced list and deletes its synced
      thumbnail and .torrent file; it stays in the groups it was in until you delete them.
      Deleting your FKN account at{' '}
      <a href="https://fkn.app" target="_blank" rel="noreferrer noopener">fkn.app</a>{' '}
      deletes everything Ripple stored in it.
    </p>

    <h2>Contact</h2>
    <p>
      Questions about privacy? Reach us at{' '}
      <a href="mailto:admin@fkn.app">admin@fkn.app</a>.
    </p>
  </LegalDoc>
)

export default Privacy
