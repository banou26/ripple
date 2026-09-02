export const DEMO_SEEDED_KEY = 'ripple:demo-seeded'
/** Whether a torrent that has landed in the user's folder should give up Ripple's own OPFS copy. */
export const FREE_AFTER_SAVE_KEY = 'ripple:free-after-save'

/**
 * The bundled demo torrent, and the directory it must be given.
 *
 * The save path is not cosmetic and it is not the default. A `.torrent` add cannot name its own
 * directory in general, because the infohash only appears after the add, so `worker.ts` roots one at
 * the SHARED_ROOT. But eviction refuses any candidate that does not own its whole directory
 * (`ownsItsDirectory`, which requires exactly `/dl/<infoHash>`), so a torrent added at the shared
 * root is marked temporary and can then never be reclaimed by anything: the label promises something
 * the budget pass cannot deliver.
 *
 * The demo is the one `.torrent` whose infohash is known before the add, so it is the one that can
 * be handed its directory up front. Derived from the magnet rather than written twice.
 */
export const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
