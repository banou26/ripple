import LegalDoc from '../components/legal-doc'

const Privacy = () => (
  <LegalDoc>
    <h1>Privacy</h1>
    <div className="updated">Last updated 17 October 2026</div>

    <p>
      Ripple needs no account and runs no analytics. Used without an account, it keeps
      everything on your device and stores nothing about you on any server.
    </p>

    <h2>What Ripple stores on your device</h2>
    <p>
      Your torrent list, each torrent&rsquo;s resume data and thumbnail, and your settings
      (such as speed limits and how the list is sorted) live in your browser&rsquo;s storage
      (IndexedDB and local storage). Downloaded files live in your browser&rsquo;s storage
      (OPFS). If you choose a folder on your disk, finished downloads are saved there. Once
      you sign in, Ripple also remembers which FKN account your list belongs to.
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
      torrents you removed and when, so other devices remove them too, and one thumbnail
      picture per torrent. It never syncs the downloaded files themselves.
    </p>
    <p>
      All of it is encrypted in your browser before it is uploaded, so FKN stores it without
      being able to read it. File names stay visible to FKN, but they do not say which
      torrents you have. Without an account connected, nothing is synced.
    </p>

    <h2>The relay and your IP address</h2>
    <p>
      Peer connections are tunneled through the FKN relay rather than opened directly, so
      the other peers in a swarm see the relay&rsquo;s IP address, not yours. The relay
      forwards traffic without storing it. Usage metering for the free and premium tiers is
      anonymized with daily-rotating keys and purged within about a day, so past transfers
      cannot be mapped back to a person, by us or anyone else. The full details are in the{' '}
      <a href="https://fkn.app/privacy" target="_blank" rel="noreferrer noopener">
        FKN platform privacy policy
      </a>.
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
      thumbnail. Deleting your FKN account at{' '}
      <a href="https://fkn.app" target="_blank" rel="noreferrer noopener">fkn.app</a>{' '}
      deletes everything Ripple stored in it.
    </p>

    <h2>Contact</h2>
    <p>
      Questions about privacy? Reach us at{' '}
      <a href="mailto:privacy@fkn.app">privacy@fkn.app</a>.
    </p>
  </LegalDoc>
)

export default Privacy
