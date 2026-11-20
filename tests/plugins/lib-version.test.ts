import LOCK from '../../package-lock.json?raw'

import { expect, it } from 'vitest'

// A plugin's page is mounted in a sandboxed frame, which starts only from @fkn/lib 0.9.76 (HOR-1373): before it, the
// package in such a frame never told the page it had loaded.
const MOUNTS_SANDBOXED = [0, 9, 76]

it('installs an @fkn/lib a plugin\'s page can be mounted with', () => {
  const lock = JSON.parse(LOCK) as { packages: Record<string, { version: string }> }
  const version = lock.packages['node_modules/@fkn/lib']!.version.split('.').map(Number)
  const newer = version.findIndex((part, i) => part !== MOUNTS_SANDBOXED[i])
  expect(newer === -1 || version[newer]! > MOUNTS_SANDBOXED[newer]!, `@fkn/lib ${version.join('.')}`).toBe(true)
})
