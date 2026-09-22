/**
 * The npm publish is a TRUST RELATIONSHIP held in three places at once, and two of them are text
 * files here. npm exchanges the workflow's OIDC identity for a publish credential only when the
 * claim matches the publisher registered on npmjs.org: owner, repository, and WORKFLOW FILENAME,
 * all case sensitive. The registry then refuses the upload unless package.json names the same
 * repository the provenance statement was signed against.
 *
 * Each pin below is a failure that has been paid for once, and every one of them reports something
 * other than its cause: a renamed workflow file answers ENEEDAUTH, `registry-url` on setup-node
 * answers E404 on the PUT, and a missing `repository` answers 422 after the statement is already in
 * the public transparency log. None of them can be seen before a release, which is why they are
 * asserted here rather than discovered there.
 *
 * Read through vite with `?raw` rather than `node:fs`, for the reason `lanes.test.ts` records.
 */
import pkg from '../package.json'

import { describe, expect, it } from 'vitest'

/** owner and repo exactly as the OIDC claim spells them, lowercase since the 2026-09-11 rename */
const REPOSITORY = 'banou26/ripple'

/** the filename registered as the trusted publisher; renaming the file revokes publishing */
const WORKFLOW = '../.github/workflows/publish-lib.yml'

const workflows = import.meta.glob('../.github/workflows/*.yml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/**
 * The workflow WITHOUT its comments, which is what every assertion about its steps has to read: it
 * explains each trap it avoids by name, so `registry-url` and the gate script both appear in prose
 * whether or not the step using them survives an edit.
 */
const steps = () => (workflows[WORKFLOW] ?? '').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')

describe('the trusted publisher', () => {
  it('found the workflow at all, so a false pass here is not a bad glob', () => {
    expect(Object.keys(workflows), 'no workflow file was read, so every assertion below is vacuous').not.toEqual([])
    expect(workflows[WORKFLOW], `${WORKFLOW} is the filename npmjs.org binds the package to`).toBeTruthy()
    expect(workflows[WORKFLOW]).toContain('runs-on')
  })

  it('asks for the OIDC token, without which there is no credential to exchange', () => {
    expect(steps()).toMatch(/id-token:\s*write/)
  })

  it('leaves the registry alone, so npm reaches for the exchange instead of a token', () => {
    // `registry-url` writes an .npmrc auth line and an empty NODE_AUTH_TOKEN; npm then believes it is
    // authenticated, never exchanges, and the publish fails naming the package rather than the auth.
    // Comments are stripped first, since the workflow explains the trap it is avoiding.
    expect(steps(), 'registry-url on setup-node skips the OIDC exchange entirely').not.toMatch(/registry-url/)
  })

  it('publishes the scope publicly, which a scoped package does not do by default', () => {
    expect(steps(), 'a bare name is a package spec to npm, so the path has to say it is a directory').toContain('npm publish ./build --access public')
  })

  it('asks the gate before building, so a reserved number never reaches a build', () => {
    expect(steps(), 'the tombstone case is in that script, not in the workflow').toContain('node scripts/npm-version-gate.mjs')
  })

  // This lived in the signing tests until the signing went, and neither half of it was ever about
  // signing: the token only needs to read, and a publish job that writes to its own repository is a
  // job whose every run changes the branch that triggers it.
  it('only reads the repository and never writes back to it', () => {
    expect(steps(), 'the checkout is all this job needs the repository for').toMatch(/contents:\s*read/)
    expect(steps()).not.toMatch(/contents:\s*write/)
    expect(steps(), 'nothing here should commit or push to the branch that triggers it').not.toMatch(/git (?:commit|push)/)
  })
})

describe('what provenance compares the upload against', () => {
  it('names the repository, in the shape the registry strips down to a url', () => {
    const url = (pkg as { repository?: { url?: string } }).repository?.url
    expect(url, 'no repository field, so the signed statement has nothing to match and the PUT is refused').toBeTruthy()
    expect(url!.replace(/^git\+/, '').replace(/\.git$/, '')).toBe(`https://github.com/${REPOSITORY}`)
  })
})

describe('confirming the release', () => {
  /**
   * The registry answers a publish with 202 and processes it afterwards, so the version appears
   * minutes later: 0.0.9 took about 4, and 0.0.10 took 10 minutes 12 seconds, which failed the
   * ten minute window this had on a publish that had worked.
   */
  it('waits long enough for the registry to finish processing a publish', () => {
    const loop = steps().match(/for attempt in \$\(seq 1 (\d+)\)[\s\S]*?sleep (\d+)/)
    expect(loop, 'the confirm loop moved or changed shape').toBeTruthy()
    expect(Number(loop![1]) * Number(loop![2]), 'seconds the confirm step waits').toBeGreaterThanOrEqual(30 * 60)
  })

  /**
   * The job has to outlast the one wait it is allowed to perform, and the expensive half of a
   * release is already paid for by the time it starts. A timeout expiring PAST `npm publish` spends
   * the version number and leaves it unconfirmed: the gate answers changed=false on a dispatch
   * re-run, so none of the release steps run again.
   */
  it('outlasts its retry window, with the build and the publish still to pay for', () => {
    const loops = [...steps().matchAll(/for attempt in \$\(seq 1 (\d+)\)[\s\S]*?sleep (\d+)/g)]
    expect(loops.length, 'a retry loop moved or changed shape, so the sum below is not the job budget').toBe(1)
    const waiting = loops.reduce((total, loop) => total + Number(loop[1]) * Number(loop[2]), 0)
    const timeout = steps().match(/timeout-minutes: (\d+)/)
    expect(timeout, 'the job declares no timeout, so a hung step runs for the runner maximum').toBeTruthy()
    expect(Number(timeout![1]) * 60 - waiting, 'seconds left for checkout, npm ci, the build and the publish').toBeGreaterThanOrEqual(15 * 60)
  })
})
