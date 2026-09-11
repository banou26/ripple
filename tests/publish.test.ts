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

  it('asks the gate before building, so a reserved number never reaches a signature', () => {
    expect(steps(), 'the tombstone case is in that script, not in the workflow').toContain('node scripts/npm-version-gate.mjs')
  })
})

describe('what provenance compares the upload against', () => {
  it('names the repository, in the shape the registry strips down to a url', () => {
    const url = (pkg as { repository?: { url?: string } }).repository?.url
    expect(url, 'no repository field, so the signed statement has nothing to match and the PUT is refused').toBeTruthy()
    expect(url!.replace(/^git\+/, '').replace(/\.git$/, '')).toBe(`https://github.com/${REPOSITORY}`)
  })
})
