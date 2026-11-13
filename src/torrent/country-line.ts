import { defineMessage } from 'react-intl'

/** The second sentence of the warning shown when the VPN is switched off, on a device inListedCountry() answers yes for. */
export const COUNTRY_LINE = defineMessage({
  id: 'In your country, sharing copyrighted files this way can lead to a demand for money.',
  defaultMessage: 'In your country, sharing copyrighted files this way can lead to a demand for money.',
})

/**
 * The countries where the warning shown when the VPN is switched off adds its second sentence, by ISO 3166 code, each
 * with the ids the tz database's zone.tab gives it (release 2026f): a country's own ids, never the ids of a zone it
 * shares a clock with, so Europe/Stockholm is Sweden although the tz database links it to Europe/Berlin. Checked
 * 2026-11-14. The evidence for each country, and how the list is kept, are in the knowledge base: banou26/agent,
 * roadmap/decisions/ripple-66/countries.md.
 */
export const LISTED_ZONES: Readonly<Record<string, readonly string[]>> = {
  DE: ['Europe/Berlin', 'Europe/Busingen'],
  JP: ['Asia/Tokyo'],
  US: [
    'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
    'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indiana/Marengo',
    'America/Indiana/Petersburg', 'America/Indiana/Vevay', 'America/Chicago', 'America/Indiana/Tell_City',
    'America/Indiana/Knox', 'America/Menominee', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
    'America/North_Dakota/Beulah', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome',
    'America/Adak', 'Pacific/Honolulu',
  ],
  FI: ['Europe/Helsinki'],
  ES: ['Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary'],
  KR: ['Asia/Seoul'],
  CA: [
    'America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton', 'America/Goose_Bay',
    'America/Blanc-Sablon', 'America/Toronto', 'America/Iqaluit', 'America/Atikokan', 'America/Winnipeg',
    'America/Resolute', 'America/Rankin_Inlet', 'America/Regina', 'America/Swift_Current', 'America/Edmonton',
    'America/Cambridge_Bay', 'America/Inuvik', 'America/Vancouver', 'America/Creston', 'America/Dawson_Creek',
    'America/Fort_Nelson', 'America/Whitehorse', 'America/Dawson',
  ],
  LT: ['Europe/Vilnius'],
  TW: ['Asia/Taipei'],
  // under Finland's law
  AX: ['Europe/Mariehamn'],
  // under the United States' law
  PR: ['America/Puerto_Rico'],
  VI: ['America/St_Thomas'],
  GU: ['Pacific/Guam'],
  MP: ['Pacific/Saipan'],
  AS: ['Pacific/Pago_Pago'],
}

const LISTED = new Set(Object.values(LISTED_ZONES).flat())

// the name Chrome 156 and Node 26 report for a listed zone.tab id where ICU's differs, measured 2026-11-14; Firefox 158
// reports the zone.tab id, and both browsers report an old name (US/Eastern, Japan, ROK) as its zone.tab id or as one
// of these names (America/Fort_Wayne as America/Indianapolis)
const ICU_NAMES: ReadonlyMap<string, string> = new Map([
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
])

/**
 * Whether the warning shown when the VPN is switched off adds its second sentence: whether `timeZone`, by default this
 * device's, is in a listed country. An unknown id, UTC, and Atlantic/Reykjavik, which Firefox reports while it hides
 * the zone, answer no. The zone is read on each call and kept nowhere.
 */
export const inListedCountry = (timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): boolean =>
  LISTED.has(ICU_NAMES.get(timeZone) ?? timeZone)
