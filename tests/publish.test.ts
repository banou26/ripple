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
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const block = (name: string) => {
  const text = steps()
  const at = text.indexOf(`- name: ${name}`)
  const next = text.indexOf('- name: ', at + 1)
  return text.slice(at, next === -1 ? undefined : next)
}

/** A step's `run: |` block under `bash -e`, which is how Actions runs a `run:`, with `stubs` as commands ahead of PATH. */
const runStep = (name: string, stubs: Record<string, string>, env: Record<string, string>) => {
  const lines = block(name).split('\n')
  const at = lines.findIndex((line) => line.trim() === 'run: |')
  expect(at, `the ${name} step has no \`run: |\` block to execute`).toBeGreaterThan(-1)
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((line) => line.trim() && line.search(/\S/) <= lines[at]!.search(/\S/))
  const body = rest.slice(0, end === -1 ? undefined : end)
  const indent = body.find((line) => line.trim())!.search(/\S/)
  const dir = mkdtempSync(join(tmpdir(), 'ripple-publish-'))
  try {
    writeFileSync(join(dir, 'step.sh'), body.map((line) => line.slice(indent)).join('\n'))
    for (const [command, script] of Object.entries(stubs)) writeFileSync(join(dir, command), script, { mode: 0o755 })
    writeFileSync(join(dir, 'output'), '')
    const run = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), ...env },
    })
    return { status: run.status, log: run.stdout, stderr: run.stderr, output: readFileSync(join(dir, 'output'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
  it('outlasts its retry windows, with the build and the publish still to pay for', () => {
    // the registry's, and the device check's after it (slice 9)
    const loops = [...steps().matchAll(/for attempt in \$\(seq 1 (\d+)\)[\s\S]*?sleep (\d+)/g)]
    expect(loops.length, 'a retry loop moved or changed shape, so the sum below is not the job budget').toBe(2)
    const waiting = loops.reduce((total, loop) => total + Number(loop[1]) * Number(loop[2]), 0)
    const timeout = steps().match(/timeout-minutes: (\d+)/)
    expect(timeout, 'the job declares no timeout, so a hung step runs for the runner maximum').toBeTruthy()
    expect(Number(timeout![1]) * 60 - waiting, 'seconds left for checkout, npm ci, the build and the publish').toBeGreaterThanOrEqual(15 * 60)
  })
})

// HOR-233 slice 9: every release is signed in place, and devices check it after it is served
describe('the in-place signature', () => {
  const names = () => [...steps().matchAll(/- name: (.+)/g)].map((match) => match[1]!.trim())

  // proof: move the sign step after Publish and the release npm serves carries no fkn.json
  it('signs the built package after the manifest check and before the publish, with the key CI holds', () => {
    const order = names()
    expect(order.indexOf('Sign the package in place')).toBeGreaterThan(order.indexOf('The built manifest has to be the one the gate cleared'))
    expect(order.indexOf('Sign the package in place')).toBeLessThan(order.indexOf('Publish'))
    expect(order.indexOf("Fetch Ripple's key list")).toBeLessThan(order.indexOf('Sign the package in place'))
    const sign = block('Sign the package in place')
    expect(sign).toContain('FKN_RELEASE_KEY: ${{ secrets.FKN_RELEASE_KEY }}')
    // ./build, the directory published, and never a bare name npm reads as a package spec
    expect(sign).toContain('npx --yes @fkn/sign@0.0.12 release ./build --npm --list "$RUNNER_TEMP/fkn-keys.json"')
    expect(block("Fetch Ripple's key list")).toContain('set -o pipefail; curl -fsS https://api.fkn.app/v1/apps/fkn:app:1c7clnsv53zt7dr7q7rcbt455hxauykaxl4gibkuoao24dfmk2eqq/keys | jq .list > "$RUNNER_TEMP/fkn-keys.json"')
    for (const name of ["Fetch Ripple's key list", 'Sign the package in place', 'Confirm devices verify it']) {
      expect(block(name), name).toContain("if: steps.decide.outputs.changed == 'true'")
    }
  })

  // exit 2 is "unpkg does not serve every file yet", the only answer worth waiting out
  it('checks what devices check once the registry serves it, retrying only while unpkg catches up', () => {
    expect(names().indexOf('Confirm devices verify it')).toBeGreaterThan(names().indexOf('Confirm the registry serves it'))
    const verify = block('Confirm devices verify it')
    expect(verify).toContain('npx --yes @fkn/sign@0.0.12 verify "npm:@banou/ripple@$VERSION" --list "$RUNNER_TEMP/fkn-keys.json"')
    expect(verify).toContain('if [ "$CODE" != "2" ]; then exit "$CODE"; fi')
  })
})

/**
 * An earlier run's upload can sit staged, held until the owner releases it on npmjs.com, and npm
 * answers the next run's PUT with 409 'Cannot publish over previously staged version "0.0.18"'
 * (2026-10-10). Only that answer, naming the version this run publishes, may pass. The step's own
 * shell runs here against an npm stub.
 */
describe('a version npm already holds as staged', () => {
  const VERSION = '0.0.18'

  const publish = (answer: string, code: number) => runStep(
    'Publish',
    { npm: `#!/bin/sh\nprintf '%s\\n' "$NPM_ANSWER" >&2\nexit ${code}\n` },
    { NAME: '@banou/ripple', VERSION, NPM_ANSWER: answer },
  )

  const conflict = (message: string) => `npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@banou%2fripple - ${message}`

  it('passes the staged 409 for its own version, says so, and skips the registry checks', () => {
    const { status, log, output } = publish(conflict(`Cannot publish over previously staged version "${VERSION}".`), 1)
    expect(status).toBe(0)
    expect(log).toContain(`::notice::npm already holds @banou/ripple ${VERSION} as staged`)
    expect(output).toBe('held=true\n')
    expect(block('Publish')).toContain('id: publish')
    for (const name of ['Confirm the registry serves it', 'Confirm devices verify it']) {
      expect(block(name), name).toContain("if: steps.decide.outputs.changed == 'true' && steps.publish.outputs.held != 'true'")
    }
  })

  it('passes a publish npm accepts, leaving the registry checks to run', () => {
    expect(publish(`+ @banou/ripple@${VERSION}`, 0)).toMatchObject({ status: 0, output: '' })
  })

  it.each([
    ['a staged 409 for another version', conflict('Cannot publish over previously staged version "0.0.17".')],
    ['a staged 409 for a version this one prefixes', conflict('Cannot publish over previously staged version "0.0.180".')],
    ['any other 409', conflict('Document update conflict.')],
    ['a 403', `npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@banou%2fripple - You cannot publish over the previously published versions: ${VERSION}.`],
    ['a network error', 'npm error code ECONNRESET\nnpm error network aborted'],
  ])('fails on %s', (_, answer) => {
    expect(publish(answer, 1)).toMatchObject({ status: 1, output: '' })
  })
})

/**
 * A push starts Test and a push-triggered Publish at the same moment, so 0.0.26 and 0.0.27 published while their Test
 * runs were red. Publish now follows Test's completion, and a dispatch has to show a green Test run for its commit.
 */
describe('a release waits on Test', () => {
  const triggers = () => steps().slice(steps().indexOf('\non:'), steps().indexOf('\nconcurrency:'))
  const job = () => steps().slice(steps().indexOf('\n  publish:'), steps().indexOf('runs-on:'))

  it('starts when Test completes on main, and never on the push beside it', () => {
    const test = /^name:\s*(.+)$/m.exec(workflows['../.github/workflows/test.yml'] ?? '')?.[1]?.trim()
    expect(test, 'workflow_run matches the `name:` of test.yml, and a rename there stops every release').toBe('Test')
    expect(triggers()).toMatch(/workflow_run:\s+workflows: \[Test\]\s+types: \[completed\]\s+branches: \[main\]/)
    expect(triggers(), 'a push trigger starts the release before Test has answered').not.toMatch(/^\s+push:/m)
  })

  // the job builds github.sha, so the run it follows has to be green and for that very commit
  it('releases only a green Test run of a push, on the commit main is at', () => {
    expect(job()).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(job(), 'a pull request from a fork branch named main also matches `branches`').toContain("github.event.workflow_run.event == 'push'")
    expect(job()).toContain('github.event.workflow_run.head_sha == github.sha')
    expect(steps(), 'checking out anything but github.sha builds a commit the check above did not compare').not.toMatch(/^\s+ref:/m)
  })

  describe('a dispatch', () => {
    const SHA = '58ddc235cca2643ee0c2d3eaf8ee45473e0e9b31'
    const gate = (answer: string, code = 0) => runStep(
      'Require a green Test run for this commit',
      { gh: `#!/bin/sh\necho "$*" >&2\nprintf '%s' "$GH_ANSWER"\nexit ${code}\n` },
      { GITHUB_REPOSITORY: 'banou26/ripple', GITHUB_SHA: SHA, GH_ANSWER: answer },
    )

    it('runs the gate unless forced, and asks only for green push runs of test.yml on this commit', () => {
      expect(block('Require a green Test run for this commit')).toContain("if: github.event_name == 'workflow_dispatch' && inputs.force != true")
      expect(gate('1').stderr).toContain(`repos/banou26/ripple/actions/workflows/test.yml/runs?head_sha=${SHA}&event=push&status=success`)
      expect(steps(), 'reading the runs of Test needs the actions scope').toMatch(/actions:\s*read/)
    })

    it('goes on when Test passed on the commit', () => {
      expect(gate('1')).toMatchObject({ status: 0 })
    })

    it.each([
      ['no green Test run', '0', 0],
      ['an answer that is not a count', '', 0],
      ['the API refusing', '', 1],
    ])('stops on %s', (_, answer, code) => {
      expect(gate(answer, code).status).not.toBe(0)
    })
  })
})
