/**
 * Every Playwright spec belongs to a lane, and this is what stops one going quiet.
 *
 * The rot this exists to prevent already happened. `test:e2e` was a hand-written list of paths, ten
 * of the twenty-five spec files were named by no npm script at all, and CI ran only the unit project.
 * So four `storage-eviction` tests sat failing on `main` with nothing anywhere going red, and they
 * were found by a run nobody had asked for.
 *
 * A gate alone would not have caught that: it would have run the same hand-written list and been just
 * as blind to the files missing from it. What closes the hole is deriving the inventory from the
 * DIRECTORY and asserting the scripts cover it, so a new spec is not merely unrun, it is a failing
 * test in the fast suite until somebody decides which lane it belongs in.
 *
 * The lanes split by DEPENDENCY, not by cost. See LANES below for what each one depends on.
 *
 * Read through vite rather than `node:fs`: this runs in the `unit` project, whose config applies
 * `vite-plugin-node-stdlib-browser`, and importing `node:fs` there fails resolving `punycode`.
 * `import.meta.glob` is answered by the bundler and needs no filesystem at all.
 */
import pkg from '../package.json'

import { describe, expect, it } from 'vitest'

const scripts = pkg.scripts as Record<string, string>

/**
 * The three lanes, in the order they cost.
 *
 *  - `local` needs a browser and nothing else, and is deterministic anywhere. It gates a push.
 *  - `machine` is deterministic only where the MACHINE is: `stable-widths` measures that tabular
 *    readouts hold their width, which a runner with a different font set fails while the code is
 *    perfect. Split out after CI failed it twice on font metrics alone.
 *  - `swarm` watches a torrent actually move bytes, so it needs a headful browser and live seeders.
 */
const LANES = ['e2e:local', 'e2e:machine', 'e2e:swarm']

/** Every spec a run could pick up, straight off the directory. */
const sources = import.meta.glob('./*.spec.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const onDisk = Object.keys(sources)
  .map((path) => path.replace('./', 'tests/'))
  .sort()

/** The paths one lane names, read back out of the script that runs it. */
const lane = (name: string): string[] => {
  const script = scripts[name]
  if (!script) throw new Error(`package.json has no "${name}" script`)
  return [...script.matchAll(/tests\/[\w.-]+\.spec\.ts/g)].map((m) => m[0]).sort()
}

const fixmes = (path: string) =>
  (sources[path.replace('tests/', './')]?.match(/\btest\.fixme\(/g) ?? []).length

describe('the e2e lanes', () => {
  it('covers every spec on disk exactly once', () => {
    const lanes = LANES.map(lane)
    const named = lanes.flat().sort()

    // the message matters more than the assertion: whoever added the file has to choose a lane
    expect(named, 'a spec file is in no lane, so nothing would ever run it').toEqual(onDisk)
    expect(
      named.filter((path, i) => named.indexOf(path) !== i),
      'a spec in two lanes runs twice and gates on the slower one',
    ).toEqual([])
  })

  it('builds before each lane, and neither tolerates a committed .only', () => {
    // `--forbid-only` is what stops one committed `test.only` silencing a whole file in CI
    for (const name of LANES) {
      expect(scripts[name], `${name} must refuse a committed .only`).toContain('--forbid-only')
    }
    for (const name of LANES.map((lane) => lane.replace('e2e:', 'test:e2e:'))) {
      expect(scripts[name], `${name} must build before it drives the built app`).toContain('npm run build')
    }
  })

  /**
   * The four are counted, not merely annotated.
   *
   * They fail on `main` and predate the work that found them: a run failed six, and reverting one
   * file to its previous commit and re-running the same specs failed four. So `test.fixme` is an
   * honest record of a known gap rather than a way to make a suite look green, and pinning the count
   * is what stops a fifth being quietly added to the pile.
   */
  it('holds exactly the four known-failing eviction tests, and none anywhere else', () => {
    expect(fixmes('tests/storage-eviction.spec.ts')).toBe(4)
    const elsewhere = onDisk
      .filter((path) => path !== 'tests/storage-eviction.spec.ts')
      .filter((path) => fixmes(path) > 0)
    expect(elsewhere, 'a spec was skipped with test.fixme outside the known set').toEqual([])
  })
})
