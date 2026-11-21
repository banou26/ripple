import LOCK from '../../package-lock.json?raw'

import { expect, it } from 'vitest'

// Inside fkn.app, plugins wait on shell.isAppTab, which @fkn/lib answers from 0.9.84 (HOR-1459). A plugin's page is
// mounted in a sandboxed frame, which starts only from 0.9.76 (HOR-1373).
const FLOOR = [0, 9, 84]

it('installs an @fkn/lib that answers isAppTab and can mount a plugin\'s page', () => {
  const lock = JSON.parse(LOCK) as { packages: Record<string, { version: string }> }
  const version = lock.packages['node_modules/@fkn/lib']!.version.split('.').map(Number)
  const newer = version.findIndex((part, i) => part !== FLOOR[i])
  expect(newer === -1 || version[newer]! > FLOOR[newer]!, `@fkn/lib ${version.join('.')}`).toBe(true)
})
