import LegalDoc from '../components/legal-doc'

const Privacy = () => (
  <LegalDoc>
    <h1>Privacy</h1>
    <div className="updated">Last updated 5 July 2026</div>

    <p>
      Ripple needs no account and runs no analytics. Used without an account, it keeps
      everything on your device and stores nothing about you on any server.
    </p>

    <h2>What Ripple stores on your device</h2>
    <p>
      Your torrent list and all downloaded data live in your browser&rsquo;s storage
      (OPFS and IndexedDB) on your device. Removing a torrent in Ripple also deletes its
      downloaded data. The files you download are never uploaded or reported anywhere by
      Ripple itself.
    </p>

    <h2>Torrent list sync when signed in</h2>
    <p>
      If you connect an FKN account, Ripple stores your torrent list (magnet links, save
      paths, and when you added each torrent; never the downloaded files themselves) in
      that account&rsquo;s FKN cloud storage, encrypted in transit, so your library
      follows you across devices. Without an account connected, nothing is synced and
      everything stays local. Disconnecting the account stops the sync, and removing
      torrents while signed in also removes them from the synced list.
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
      Removing a torrent deletes its data from your device. Clearing this site&rsquo;s data
      in your browser removes everything Ripple has stored on your device. Ripple itself
      has no account to delete; if you use an FKN account for premium or sync, the account
      and its synced torrent list are managed at{' '}
      <a href="https://fkn.app" target="_blank" rel="noreferrer noopener">fkn.app</a>.
    </p>

    <h2>Contact</h2>
    <p>
      Questions about privacy? Reach us at{' '}
      <a href="mailto:privacy@fkn.app">privacy@fkn.app</a>.
    </p>
  </LegalDoc>
)

export default Privacy
