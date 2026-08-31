/*
 * Live figures must not shove the things beside them.
 *
 * `tabular-nums` was already set in both places and is not the fix: it stops DIGITS jittering and
 * does nothing about a string getting longer, which is what moves a row. 9.9 MB/s to 10.2 MB/s to
 * 999.9 kB/s happens several times a second on anything downloading, and each change drags every
 * readout to its right along with it.
 *
 * Driven rather than observed: waiting for real values to vary tests whatever the swarm happened to
 * do in the window, where writing the range in tests the rule.
 */
import { expect, test } from '@playwright/test'

const SPEEDS = ['0 B/s', '9.9 kB/s', '999.9 kB/s', '9.9 MB/s', '99.9 MB/s', '999.9 MB/s', '1.23 GB/s']

test('the global rate readouts hold their width as the number changes', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await page.locator('.stats .stat.big.rate strong').waitFor({ timeout: 90_000 })

  const lefts = await page.evaluate((speeds) => {
    const download = document.querySelector('.stats .stat.big.rate strong') as HTMLElement
    // the readout after it is what gets shoved, so its left edge is the thing under test
    const after = document.querySelector('.stats .stat.rate:not(.big) strong') as HTMLElement
    const seen: number[] = []
    for (const value of speeds) {
      download.textContent = value
      seen.push(Math.round(after.getBoundingClientRect().left))
    }
    return seen
  }, SPEEDS)

  expect(new Set(lefts).size, `the readout beside Download moved to ${lefts.join(', ')}`).toBe(1)
})

test('a row holds its layout as its own figures change', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await page.locator('.torrent .meta .pair').first().waitFor({ timeout: 90_000 })

  const moved = await page.evaluate((speeds) => {
    const meta = document.querySelector('.torrent .meta') as HTMLElement
    const pair = meta.querySelector('.pair') as HTMLElement
    const down = meta.querySelectorAll('.rate')[0] as HTMLElement
    const peers = meta.querySelector('.peers') as HTMLElement
    // whatever sits after the peer count is the last thing that can be shoved
    const last = meta.lastElementChild as HTMLElement

    const pairs = ['0 B / 1.2 GB', '129.2 MB / 1.2 GB', '999.9 MB / 999.9 MB', '1.23 GB / 1.23 GB']
    const counts = ['0 peers', '9 peers', '999 peers']
    const out: Record<string, number[]> = { afterPair: [], afterRate: [], afterPeers: [] }

    for (const value of pairs) { pair.textContent = value; out.afterPair!.push(Math.round(down.getBoundingClientRect().left)) }
    pair.textContent = pairs[0]!
    for (const value of speeds) { down.textContent = `↓ ${value}`; out.afterRate!.push(Math.round(peers.getBoundingClientRect().left)) }
    down.textContent = '↓ 0 B/s'
    for (const value of counts) { peers.textContent = value; out.afterPeers!.push(Math.round(last.getBoundingClientRect().left)) }
    return out
  }, SPEEDS)

  expect(new Set(moved.afterPair).size, `the speed moved to ${moved.afterPair.join(', ')} as the size pair changed`).toBe(1)
  expect(new Set(moved.afterRate).size, `the peer count moved to ${moved.afterRate.join(', ')} as the speed changed`).toBe(1)
  expect(new Set(moved.afterPeers).size, `the line after the peers moved to ${moved.afterPeers.join(', ')}`).toBe(1)
})
