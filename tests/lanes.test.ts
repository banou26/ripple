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
   * Nothing is annotated away any more, and this is what keeps it that way.
   *
   * There were four, all in `storage-eviction.spec.ts`, and this used to pin the count at four so a
   * fifth could not be quietly added to the pile. They are gone: the reason they failed was measured
   * on 2026-09-03 and was not about the engine at all. On Chromium the storage quota is a ceiling
   * that FLOATS with usage, so `quota - usage` never falls however much padding a test writes, and
   * every one of them squeezed the origin to provoke an eviction that therefore could not happen.
   * They now measure that and skip with the measured reason where it holds.
   *
   * So the bar goes back up: zero. A `test.fixme` is a test that fails and says nothing about why,
   * and the four here cost months of looking like a known gap when they were a rig that could not
   * ask its question.
   */
  it('annotates no test away with test.fixme, in any spec', () => {
    const annotated = onDisk.filter((path) => fixmes(path) > 0)
    expect(annotated, 'test.fixme hides a failure without saying why: skip on a measured condition').toEqual([])
  })

  /**
   * A skip has to say WHY, on the spot.
   *
   * That is the whole difference between a skip and the `fixme` it replaced. `test.skip(condition)`
   * with no second argument reports as "skipped" in a run and leaves whoever reads the output to go
   * and find the condition; so does a bare `test.skip()`. Both are a `fixme` under another name.
   *
   * `test.skip(true, 'reason')` inside an `if` is NOT one of those and must keep passing: two specs
   * decide at runtime whether a tool is present and then skip with the reason, which is the honest
   * shape this is asking for. An earlier version of this test forbade the literal `true` outright and
   * flagged exactly that, which is the failure mode a rule like this has: refusing the good case.
   */
  it('gives every skip a reason, wherever the condition is decided', () => {
    /**
     * Every `test.skip(...)` call, and whether it was given a SECOND argument.
     *
     * The reason is not always a literal: the eviction spec passes a named constant, so looking for
     * a quote inside the call reports the well-behaved case as bare. What is actually being asked is
     * "is there an argument after the condition", which is a comma at the call's own depth.
     */
    const skipCalls = (source: string): { text: string, hasReason: boolean }[] => {
      const out: { text: string, hasReason: boolean }[] = []
      const marker = /\btest\.skip\(/g
      for (let found = marker.exec(source); found; found = marker.exec(source)) {
        let depth = 0
        let hasReason = false
        let i = found.index + found[0].length - 1
        // Balanced on parens alone, which is enough here: the conditions in these specs are regex
        // literals and calls, and both carry their own parens in pairs.
        for (; i < source.length; i++) {
          if (source[i] === '(') depth++
          else if (source[i] === ',' && depth === 1) hasReason = true
          else if (source[i] === ')' && --depth === 0) break
        }
        out.push({ text: source.slice(found.index, i + 1), hasReason })
      }
      return out
    }

    const bare: string[] = []
    for (const path of onDisk) {
      for (const call of skipCalls(sources[path.replace('tests/', './')] ?? '')) {
        if (!call.hasReason) bare.push(`${path}: ${call.text.replace(/\s+/g, ' ').slice(0, 80)}`)
      }
    }
    expect(bare, 'a skipped test has to carry its reason where the run prints it').toEqual([])
  })
})

/**
 * The same argument as the lanes above, one level up: a check nothing runs is a check that rots.
 *
 * `tsc --noEmit` had never been run by anything. It was red, with fourteen errors, and had been for
 * long enough that nobody could say when they arrived, because the repo has no typecheck script and
 * CI has no step that would have printed them. A type error is exactly the class a unit suite cannot
 * see: the tests ran green over the whole of it.
 *
 * So the gates are named here and matched against the workflow. `npm test` is spelled `npm test` in
 * CI and `test` in package.json, so both forms count; the check is that the script exists AND that
 * the workflow names it, since either half alone is a gate that runs nothing.
 */
describe('the checks CI actually runs', () => {
  const workflows = import.meta.glob('../.github/workflows/*.yml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const ci = Object.values(workflows).join('\n')

  const GATES = ['typecheck', 'test', 'test:browser', 'test:e2e:local', 'test:e2e:machine', 'test:e2e:swarm']

  it('found the workflow at all, so a false pass here is not a bad glob', () => {
    expect(Object.keys(workflows), 'no workflow file was read, so every assertion below is vacuous').not.toEqual([])
    expect(ci).toContain('runs-on')
  })

  it('names every gate, so none can go quiet the way the type check did', () => {
    const unrun = GATES.filter((gate) => {
      if (!scripts[gate]) return true
      // npm allows `npm test` for the one script it has a shorthand for, and CI uses it
      return !(ci.includes(`npm run ${gate}`) || (gate === 'test' && /\bnpm test\b/.test(ci)))
    })
    expect(unrun, 'a gate no workflow step runs is a check that cannot fail').toEqual([])
  })
})
