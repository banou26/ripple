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

import { MANIFEST_MAX_BYTES } from '@fkn/sign'
import { describe, expect, it } from 'vitest'

// Asked of the runtime rather than imported: this config aliases the node builtins to
// node-stdlib-browser for the app bundle, and the unit project extends it, so `import` from
// 'node:fs' here answers the browser shim whose mkdtempSync is not a function.
const { spawnSync } = process.getBuiltinModule('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = process.getBuiltinModule('node:fs')
const { tmpdir } = process.getBuiltinModule('node:os')
const { join } = process.getBuiltinModule('node:path')

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

/** Every step of the job as its own text, so a `if:` can be read as belonging to one step. */
const stepBlocks = () => steps().split(/\n {6}- /).slice(1)

const stepNamed = (name: string) => stepBlocks().find((block) => block.startsWith(`name: ${name}`))

/** Where a command sits in the job, for the assertions that are about ORDER rather than presence. */
const positionOf = (needle: string): number => {
  const index = steps().indexOf(needle)
  expect(index, `${needle} is not in ${WORKFLOW}, so an order assertion over it would be vacuous`).toBeGreaterThan(-1)
  return index
}

/**
 * One step's shell, dedented, as bash receives it. Read from the RAW workflow rather than the
 * comment-stripped copy above, because a shell comment inside a `run` body is part of the script.
 */
const scriptOf = (name: string): string => {
  const raw = workflows[WORKFLOW] ?? ''
  const step = raw.indexOf(`- name: ${name}\n`)
  expect(step, `no step named '${name}', so a behaviour assertion over its shell would be vacuous`).toBeGreaterThan(-1)
  const block = raw.indexOf('run: |', step)
  expect(block, `the step named '${name}' runs no inline shell`).toBeGreaterThan(-1)
  const body = raw.slice(block).split('\n').slice(1)
  const lines: string[] = []
  for (const line of body) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    lines.push(line.slice(10))
  }
  return `${lines.join('\n')}\n`
}

/** What one `fkn-sign verify --published` attempt answers: its exit code and the line it writes. */
type Answer = { code: number, stderr: string }

/**
 * Runs a step's shell against a scripted `fkn-sign`, and reports how many attempts it made.
 *
 * `npx` and `sleep` are both replaced on PATH: the first hands back the next scripted answer and
 * counts the call, the second returns at once so a forty attempt loop costs no wall clock. The
 * ATTEMPT COUNT is the measurement, since a loop that reaches the same red forty attempts later
 * still exits non-zero and would pass an assertion about the exit code alone.
 */
const attemptsOf = (script: string, answers: Answer[], env: Record<string, string>): { code: number, attempts: number } => {
  const root = mkdtempSync(join(tmpdir(), 'ripple-publish-'))
  const bin = join(root, 'bin')
  const scripted = join(root, 'answers')
  mkdirSync(bin)
  mkdirSync(scripted)
  for (const [index, answer] of answers.entries()) writeFileSync(join(scripted, String(index + 1)), `${answer.code}\n${answer.stderr}\n`)
  const last = answers[answers.length - 1] as Answer
  writeFileSync(join(scripted, 'rest'), `${last.code}\n${last.stderr}\n`)
  const calls = join(root, 'calls')
  writeFileSync(calls, '0\n')
  writeFileSync(join(bin, 'npx'), [
    '#!/bin/sh',
    `n=$(($(cat ${calls}) + 1))`,
    `echo "$n" > ${calls}`,
    `answer=${scripted}/$n`,
    `[ -f "$answer" ] || answer=${scripted}/rest`,
    'tail -n +2 "$answer" >&2',
    'exit "$(head -n 1 "$answer")"',
    '',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const file = join(root, 'step.sh')
  writeFileSync(file, script)
  const run = spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: root },
  })
  return { code: run.status ?? -1, attempts: Number(readFileSync(calls, 'utf8').trim()) }
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
   * The job has to outlast every wait it is allowed to perform, and the expensive half of a release
   * is already paid for by the time the first of them starts. A timeout expiring PAST `npm publish`
   * spends the version number and leaves its published bytes unread: the gate answers changed=false
   * on a dispatch re-run, so none of the release steps run again.
   */
  it('outlasts both retry windows, with the build and the publish still to pay for', () => {
    const loops = [...steps().matchAll(/for attempt in \$\(seq 1 (\d+)\)[\s\S]*?sleep (\d+)/g)]
    expect(loops.length, 'a retry loop moved or changed shape, so the sum below is not the job budget').toBe(2)
    const waiting = loops.reduce((total, loop) => total + Number(loop[1]) * Number(loop[2]), 0)
    const timeout = steps().match(/timeout-minutes: (\d+)/)
    expect(timeout, 'the job declares no timeout, so a hung step runs for the runner maximum').toBeTruthy()
    expect(Number(timeout![1]) * 60 - waiting, 'seconds left for checkout, npm ci, the build and the publish').toBeGreaterThanOrEqual(15 * 60)
  })
})

/**
 * The release manifest carries a `contents` list, so from step 5 on the platform refuses any file of
 * this package whose bytes are not the ones listed. Everything that makes that list right is here,
 * and none of it can be seen before a release: a list built from the wrong tree, built before the
 * build, or missing the source it is fetched from all publish successfully and fail at every
 * consumer, on a version number that is spent by then.
 */
describe('the contents-signed release', () => {
  it('signs the packlist of the built site, and names both sources it is served from', () => {
    const script = (pkg as { scripts?: Record<string, string> }).scripts?.['sign']
    expect(script, 'package.json has no sign script, so the workflow step running it signs nothing').toBeTruthy()
    expect(script, 'without --contents the release is identity only and its bytes are pinned by nothing').toContain('--contents build')
    expect(script, 'the list binds the name and version of the manifest that ships, which is build/package.json').toContain('--package build/package.json')
    expect(script, 'a source left out of this list is SOURCE_NOT_LISTED at every consumer of it').toContain('--sources npm:@banou/ripple,https:torrent.fkn.app')
    expect(script).toContain('--out fkn.json')
  })

  it('signs after the build, since the list is that build output read off the disk', () => {
    expect(positionOf('run: npm run sign')).toBeGreaterThan(positionOf('run: npm run build'))
  })

  it('signs only when the version moved, so an unchanged push never reaches for the secret', () => {
    const block = stepNamed('Sign the release manifest over the packlist')
    expect(block, 'the signing step is gone or renamed').toBeTruthy()
    expect(block).toContain("if: steps.decide.outputs.changed == 'true'")
    expect(block, 'the seed comes from the repository secret and nothing else').toContain('FKN_SIGNING_KEY: ${{ secrets.FKN_SIGNING_KEY }}')
  })

  it('re-reads the tree it signed, and the source list, before anything is uploaded', () => {
    const publish = positionOf('npm publish ./build --access public')
    expect(positionOf("node -e"), 'the source assertion runs after the publish, which is too late').toBeLessThan(publish)
    expect(positionOf('fkn-sign place --out build'), 'the copies would still hold the identity-only document').toBeLessThan(publish)
    expect(positionOf('fkn-sign check --package build/package.json')).toBeLessThan(publish)
    expect(positionOf('fkn-sign verify fkn.json --contents build --source npm:@banou/ripple')).toBeLessThan(publish)
  })

  it('holds the document under the cap the deployed readers read it at', () => {
    // 0.0.11 verifies under the readers that are live today because they ignore `contents` entirely.
    // They still cap the document, and past the cap they refuse it outright rather than degrading.
    const gate = steps().match(/SIZE=\$\(wc -c < fkn\.json\)[\s\S]*?-gt (\d+)/)
    expect(gate, 'the size gate moved or changed shape').toBeTruthy()
    expect(Number(gate![1])).toBe(MANIFEST_MAX_BYTES)
  })

  it('verifies what the CDN serves, which is the only reading of the published bytes', () => {
    expect(positionOf('npx fkn-sign verify --published')).toBeGreaterThan(positionOf('npm publish ./build --access public'))
  })

  it('never commits the signed document, which lists an npm packlist and not this branch', () => {
    // torrent.fkn.app is built from this branch, so a committed list would name files that source
    // does not serve. Nothing here writes to the repository, and the token cannot.
    expect(steps()).toMatch(/contents:\s*read/)
    expect(steps(), 'a commit of fkn.json would deploy an npm packlist to the website source').not.toMatch(/git (?:commit|push)/)
  })
})

/**
 * The published verify retries the CDN being behind and nothing else. Two answers wear the same exit
 * code and mean opposite things: a 404 is the CDN not having mirrored the version yet, and a
 * `mismatch` is a final reading of bytes that are already published and cannot change. Retrying the
 * second spends ten minutes reaching the red the first attempt already had, under forty lines
 * claiming the CDN is behind.
 *
 * Driven rather than read: the step's shell runs against a scripted `fkn-sign`, and the ATTEMPT
 * COUNT is what separates the two, since both paths end with the job red.
 */
describe('how the published verify answers', () => {
  const step = () => scriptOf('Verify the published files against the list')
  const env = { NAME: '@banou/ripple', VERSION: '0.0.11' }

  it('read the step at all, so a false pass here is not an empty script', () => {
    expect(step(), 'nothing was extracted, so every run below would exit 0 having done nothing').toContain('fkn-sign verify --published')
  })

  it('stops on a mismatch, which is the final answer about bytes that are already served', () => {
    const run = attemptsOf(step(), [{ code: 1, stderr: 'mismatch assets/index.js at https://unpkg.com/@banou/ripple@0.0.11' }], env)
    expect(run.attempts, 'the CDN answered about the bytes, so a second reading answers the same').toBe(1)
    expect(run.code, 'a mismatch has to fail the job').not.toBe(0)
  })

  it('stops on an unlisted path, for the same reason', () => {
    const run = attemptsOf(step(), [{ code: 1, stderr: 'unlisted assets/stray.js at https://unpkg.com/@banou/ripple@0.0.11: the list does not name it' }], env)
    expect(run.attempts).toBe(1)
    expect(run.code).not.toBe(0)
  })

  it('stops on a version the list does not carry, which no wait can change', () => {
    const run = attemptsOf(step(), [{ code: 1, stderr: 'CONTENTS_VERSION: the list names 0.0.10, not 0.0.11' }], env)
    expect(run.attempts).toBe(1)
    expect(run.code).not.toBe(0)
  })

  it('waits out a 404, which is the CDN behind rather than an answer about the bytes', () => {
    const run = attemptsOf(step(), [
      { code: 1, stderr: 'https://unpkg.com/@banou/ripple@0.0.11/fkn.json answered 404' },
      { code: 1, stderr: 'https://unpkg.com/@banou/ripple@0.0.11/fkn.json answered 404' },
      { code: 0, stderr: '' },
    ], env)
    expect(run.attempts, 'a fix that stops on every refusal makes the CDN lag a failure').toBe(3)
    expect(run.code).toBe(0)
  })

  it('waits out a CDN that is not answering at all, in either shape', () => {
    const unreachable = attemptsOf(step(), [
      { code: 1, stderr: 'https://unpkg.com/@banou/ripple@0.0.11/fkn.json is unreachable: fetch failed' },
      { code: 0, stderr: '' },
    ], env)
    expect(unreachable.attempts).toBe(2)
    expect(unreachable.code).toBe(0)
    const overloaded = attemptsOf(step(), [
      { code: 1, stderr: 'https://unpkg.com/@banou/ripple@0.0.11/?meta answered 503' },
      { code: 0, stderr: '' },
    ], env)
    expect(overloaded.attempts).toBe(2)
    expect(overloaded.code).toBe(0)
  })

  it('gives up when the CDN never catches up, rather than passing the release', () => {
    const run = attemptsOf(step(), [{ code: 1, stderr: 'https://unpkg.com/@banou/ripple@0.0.11/fkn.json answered 404' }], env)
    expect(run.attempts, 'the whole retry budget').toBe(40)
    expect(run.code).not.toBe(0)
  })
})
