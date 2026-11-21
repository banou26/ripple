// The author page (docs/plugins.md) says what the code does: each limit it gives is the one ripple holds a plugin to,
// and the switches it lists are the ones ripple offers, by the words the person reads.
import plugins from '../../docs/plugins.md?raw'
import readme from '../../README.md?raw'
// keyed by each message's English
import catalogue from '../../src/locales/he.json'

import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { BUTTONS_CHANGED_MS, BUTTONS_MS, CLICK_MS, HEADER_INLINE, ICON_BYTES, LABEL_MAX, PER_PLUGIN, PLACE_INLINE } from '../../src/plugins/buttons'
import { READ_MAX_BYTES } from '../../src/plugins/calls'
import { GESTURE_MS, MOUNT_MS, SUGGEST_LIMIT } from '../../src/plugins/host'
import { STORE_BYTES } from '../../src/plugins/store'
import { OFFERED_SWITCHES } from '../../src/plugins/switches'

const text = plugins.replace(/\s+/g, ' ')

describe('the author page', () => {
  it('gives the limits ripple holds a plugin\'s buttons, popup pages, suggest and store to', () => {
    expect(text).toContain(`\`label\`: ${LABEL_MAX} characters at most`)
    expect(text).toContain(`an SVG \`data:\` url of ${ICON_BYTES / 1024} KB at most`)
    expect(text).toContain(`should answer within ${CLICK_MS / 1000} s, or Ripple says the plugin is not responding`)
    expect(text).toContain(`\`buttons\` should answer within ${BUTTONS_MS / 1000} s`)
    expect(BUTTONS_CHANGED_MS).toBe(1_000)
    expect(text).toContain('Ripple asks again at most once a second')
    expect(text).toContain(`${STORE_BYTES / 1024} KB in all`)
    expect(text).toContain(`At most ${SUGGEST_LIMIT} proposals per gesture window`)
    expect(text).toContain(`within ${GESTURE_MS / 1000} s of a click on one of its buttons`)
    expect(text).toContain(`within ${MOUNT_MS / 1000} s`)
    expect(text).toContain(`reads at most ${READ_MAX_BYTES / (1024 * 1024)} MB`)
    expect(PER_PLUGIN).toEqual({ header: 1, 'add-field': 1, 'row-menu': 3, 'bulk-bar': 1, detail: 1, file: 1, player: 1, settings: 1 })
    expect(HEADER_INLINE).toBe(2)
    expect(PLACE_INLINE).toEqual({ header: 2, 'add-field': 1, 'bulk-bar': 2, detail: 2, file: 1, player: 1 })
    expect(text).toContain('| `header` | the library\'s header, before Create | one per plugin; the first two plugins\' are in the header, the rest in its More menu | `{}` |')
    expect(text).toContain('| `add-field` | the add field, before Open a .torrent file | one per plugin; the first plugin\'s is inline, the rest in its More menu | `{ text }` |')
    expect(text).toContain('| `row-menu` | a torrent\'s menu (right click, and its Options) under the plugin\'s name | three per plugin | `{ infoHashes: [that torrent\'s] }` |')
    expect(text).toContain('| `bulk-bar` | the selection bar, before Remove | one per plugin; the first two plugins\' are inline, the rest in its More menu | `{ infoHashes }` |')
    expect(text).toContain('| `detail` | the details header, before Close | one per plugin; the first two plugins\' are inline, the rest in its More menu | `{ infoHash, tab }` |')
    expect(text).toContain('| `file` | a file\'s row in Details, beside Save | one per plugin; the first plugin\'s is inline, the rest in its More menu | `{ infoHash, file }` |')
    expect(text).toContain('| `player` | the player\'s top row, beside Open in Ripple | one per plugin; the first plugin\'s is inline, the rest in its More menu | `{ infoHash, file, time }` |')
    expect(text).toContain('| `settings` | the plugin\'s row in Settings | one | `{}` |')
  })

  it('lists the switches ripple offers, each with the words the person reads', () => {
    const places = new Set(['header', 'add-field', 'row-menu', 'bulk-bar', 'detail', 'file', 'player', 'settings'])
    const rows = [...plugins.matchAll(/^\| `([\w-]+)` \| ([^|]+) \|/gm)].map(([, name, words]) => [name, words!.trim()])
      .filter(([name]) => !places.has(name!))
    expect(rows.map(([name]) => name)).toEqual([...OFFERED_SWITCHES])
    for (const [, words] of rows) expect(Object.keys(catalogue), words).toContain(words)
  })

  it('gives the steps for testing a plugin locally, and each file they name is there', () => {
    const steps = plugins.slice(plugins.indexOf('## Testing locally'))
    expect(plugins).toContain('## Testing locally')
    expect(steps).toContain('by its `https:` address')
    expect(steps).toContain('raise the `version`')
    expect(steps).toContain('A `localhost:<port>` address')
    const named = [...steps.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map(([, path]) => path!)
    expect(named).toEqual(['tests/plugins/packages-double.ts', 'tests/plugins/example.browser.test.tsx'])
    for (const path of named) expect(existsSync(new URL(`../../${path}`, import.meta.url)), path).toBe(true)
  })

  it('is linked from the README, with the example', () => {
    expect(readme).toContain('[Writing a plugin](docs/plugins.md)')
    expect(readme).toContain('[`examples/group-by-tracker`](examples/group-by-tracker)')
    expect(plugins).toContain('[`examples/group-by-tracker`](../examples/group-by-tracker)')
  })
})
