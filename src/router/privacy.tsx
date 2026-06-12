import LegalDoc from '../components/legal-doc'

const Privacy = () => (
  <LegalDoc>
    <h1>Privacy</h1>
    <div className="updated">Last updated 12 June 2026</div>

    <p>
      Ripple needs no account, runs no analytics, and keeps nothing about you on a server.
      There is no Ripple server.
    </p>

    <h2>What Ripple stores</h2>
    <p>
      Your torrent list and all downloaded data live entirely in your browser&rsquo;s
      storage (OPFS and IndexedDB) on your device. Removing a torrent in Ripple also
      deletes its downloaded data. Nothing you add, download, or watch is reported or
      uploaded anywhere by Ripple itself.
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
      in your browser removes everything Ripple has ever stored. Ripple itself has no
      account to delete; if you use an FKN account for premium, it is managed at{' '}
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
