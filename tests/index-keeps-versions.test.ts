/**
 * The gate the publish runs between `fkn-sign pack --index` and the upload that replaces the index
 * torrent.fkn.app serves.
 *
 * WHAT IT IS PROTECTING. `pack --index` merges, so a release can only take earlier versions off the
 * host by merging into nothing, and a bucket read that answers "The specified key does not exist"
 * is exactly that. The release then uploads a document holding this version alone, and the job's own
 * verify passes, because it reads the version just published and finds it. Nothing downstream can
 * see it: every pinned install of an earlier version and every `latest` differs record breaks at
 * once, and the run is green.
 *
 * So the assertions here are about the OUTCOME rather than about `--remote`, which is one of several
 * ways to reach that answer, and the case that matters is driven against a real http server: the
 * second reading the script makes is the index the host is serving, which is the only reading that
 * shares no credential and no code path with wrangler.
 */
import { describe, expect, it } from 'vitest'

// Asked of the runtime rather than imported, for the reason publish.test.ts records: this config
// aliases the node builtins to node-stdlib-browser, so an `import` here answers a browser shim.
const { spawn } = process.getBuiltinModule('node:child_process')
const { mkdtempSync, readFileSync, writeFileSync } = process.getBuiltinModule('node:fs')
const { createServer } = process.getBuiltinModule('node:http')
const { tmpdir } = process.getBuiltinModule('node:os')
const { join, resolve } = process.getBuiltinModule('node:path')

const SCRIPT = resolve(process.cwd(), 'scripts/index-keeps-versions.mjs')

/** a port nothing listens on, which is the shape of a host that cannot be read at all */
const CLOSED = 'http://127.0.0.1:9/.well-known/fkn-package.json'

/** An index document naming one archive per version, which is all this compares. */
const indexOf = (versions: string[]): string => JSON.stringify({
  v: 1,
  default: 'ripple',
  packages: {
    ripple: {
      latest: versions[versions.length - 1],
      versions: Object.fromEntries(versions.map((version) => [version, { url: `/packages/ripple-${version}.zip`, size: 2048 }])),
    },
  },
})

type Answer = { status: number, body: string }

/** A host serving a scripted answer per read, counting the reads: the retry count is a measurement. */
const hosting = async (answers: Answer[]) => {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? '')
    const answer = answers[seen.length - 1] ?? answers[answers.length - 1] as Answer
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(answer.body)
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/.well-known/fkn-package.json`,
    seen,
    // closeAllConnections first: the reads above are keep-alive, and `close` alone waits for a
    // socket the script has already finished with, which hangs the run rather than failing it
    close: () => new Promise<void>((closed) => {
      server.closeAllConnections()
      server.close(() => closed())
    }),
  }
}

type Fixture = { state?: string, standing?: string, merged: string }

const files = ({ state, standing, merged }: Fixture) => {
  const root = mkdtempSync(join(tmpdir(), 'ripple-index-'))
  if (state !== undefined) writeFileSync(join(root, 'state'), `${state}\n`)
  if (standing !== undefined) writeFileSync(join(root, 'standing.json'), standing)
  writeFileSync(join(root, 'merged.json'), merged)
  return root
}

/**
 * One run of the script as the workflow runs it, with the live read pointed at `url`.
 *
 * `spawn` rather than `spawnSync`: the server above is in THIS process, so a blocking wait on the
 * child deadlocks, and the child's read of it never gets an answer.
 */
const guard = async (fixture: Fixture, url: string, version = '0.0.12') => {
  const root = files(fixture)
  const child = spawn(process.execPath, [
    SCRIPT,
    '--state', join(root, 'state'),
    '--standing', join(root, 'standing.json'),
    '--merged', join(root, 'merged.json'),
    '--live', url,
    '--slot', 'ripple',
    '--version', version,
    // zero because the waits are not what is under test; the READ COUNT below still is
    '--wait', '0',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const code = await new Promise<number>((done) => child.on('close', (status) => done(status ?? -1)))
  expect(output, 'the script is not where this test looks for it, so every run here is vacuous').not.toContain('Cannot find module')
  return { code, output: output.trim() }
}

describe('the index a release is about to upload', () => {
  it('passes a merge that kept every version both readings of the host name', async () => {
    const host = await hosting([{ status: 200, body: indexOf(['0.0.10', '0.0.11']) }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.10', '0.0.11']), merged: indexOf(['0.0.10', '0.0.11', '0.0.12']) }, host.url)
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('keeps all 2 entries')
      expect(host.seen.length, 'the live index is the second reading, so it has to be read').toBe(1)
    } finally {
      await host.close()
    }
  })

  it('refuses a document that drops a version the index it merged into listed', async () => {
    const host = await hosting([{ status: 200, body: indexOf(['0.0.10', '0.0.11']) }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.10', '0.0.11']), merged: indexOf(['0.0.12']) }, host.url)
      expect(run.code, 'an index holding this release alone is the whole failure').not.toBe(0)
      expect(run.output).toContain('ripple@0.0.10')
      expect(run.output).toContain('ripple@0.0.11')
    } finally {
      await host.close()
    }
  })

  // the same drop with the host unreadable, so the record of the read is the ONLY reading there is:
  // the live comparison above would refuse this run on its own, and cannot when the host is down
  it('refuses it on the record alone, when the host cannot be read', async () => {
    const host = await hosting([{ status: 503, body: 'the PACKAGES R2 binding is not bound to this project' }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.10', '0.0.11']), merged: indexOf(['0.0.12']) }, host.url)
      expect(run.code, 'the index it merged into listed two versions this one does not').not.toBe(0)
      expect(run.output).toContain('which the index it merged into listed')
    } finally {
      await host.close()
    }
  })

  /** THE case: the read answered absence, and the host is serving an index that says otherwise. */
  it('refuses a read that found no index while the host is serving one', async () => {
    const host = await hosting([{ status: 200, body: indexOf(['0.0.10', '0.0.11']) }])
    try {
      const run = await guard({ state: 'absent', merged: indexOf(['0.0.12']) }, host.url)
      expect(run.code, 'this is the upload that takes every earlier version off the host').not.toBe(0)
      expect(run.output).toContain('ripple@0.0.10')
      expect(run.output, 'the message has to name the read rather than the index').toContain('did not read the bucket the host serves')
      expect(host.seen.length, 'the contradiction has to come from a read that happened').toBe(1)
    } finally {
      await host.close()
    }
  })

  it('passes a first release, where neither the bucket nor the host has an index', async () => {
    const host = await hosting([{ status: 404, body: 'no ripple/index.json in the packages bucket' }])
    try {
      const run = await guard({ state: 'absent', merged: indexOf(['0.0.12']) }, host.url)
      expect(run.code, run.output).toBe(0)
      expect(run.output).toContain('0.0.12')
    } finally {
      await host.close()
    }
  })

  it('refuses a first release whose index holds more than the release', async () => {
    const host = await hosting([{ status: 404, body: 'no ripple/index.json in the packages bucket' }])
    try {
      const run = await guard({ state: 'absent', merged: indexOf(['0.0.11', '0.0.12']) }, host.url)
      expect(run.code, 'a merge into nothing that produced two versions read something').not.toBe(0)
      expect(run.output).toContain('0.0.11')
    } finally {
      await host.close()
    }
  })

  it('refuses an absence no second reading could confirm, in both shapes', async () => {
    const host = await hosting([{ status: 503, body: 'the PACKAGES R2 binding is not bound to this project' }])
    try {
      const run = await guard({ state: 'absent', merged: indexOf(['0.0.12']) }, host.url)
      expect(run.code, 'taking the read at its word is what loses the index').not.toBe(0)
      expect(run.output).toContain('nothing confirms that')
      expect(host.seen.length, 'a 5xx is not an answer, so it is read again').toBe(3)
    } finally {
      await host.close()
    }
    const unreachable = await guard({ state: 'absent', merged: indexOf(['0.0.12']) }, CLOSED)
    expect(unreachable.code).not.toBe(0)
    expect(unreachable.output).toContain('unreachable')
  })

  it('takes the record when the host cannot be read but the bucket was', async () => {
    const host = await hosting([{ status: 503, body: 'the PACKAGES R2 binding is not bound to this project' }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.10', '0.0.11']), merged: indexOf(['0.0.10', '0.0.11', '0.0.12']) }, host.url)
      expect(run.code, 'the bucket read is a reading, so the merge is held to that alone').toBe(0)
      expect(run.output, 'the run has to say which reading it settled on').toContain('503')
    } finally {
      await host.close()
    }
  })

  it('refuses to run at all with no record of what the bucket read answered', async () => {
    const run = await guard({ merged: indexOf(['0.0.12']) }, CLOSED)
    expect(run.code, 'a missing record is the one case that must never be a skip').not.toBe(0)
    expect(run.output).toContain('nothing recorded')
  })

  it('refuses a packed index that does not name the release it is for', async () => {
    const host = await hosting([{ status: 200, body: indexOf(['0.0.11']) }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.11']), merged: indexOf(['0.0.11']) }, host.url)
      expect(run.code, 'an index without this release is an upload that publishes nothing').not.toBe(0)
      expect(run.output).toContain('ripple@0.0.12')
    } finally {
      await host.close()
    }
  })

  it('refuses a merged document that is not an index at all', async () => {
    const host = await hosting([{ status: 200, body: indexOf(['0.0.11']) }])
    try {
      const run = await guard({ state: 'held', standing: indexOf(['0.0.11']), merged: '<!doctype html>' }, host.url)
      expect(run.code).not.toBe(0)
      expect(run.output, 'the packed file is the one document this is about').toContain('the packed index')
    } finally {
      await host.close()
    }
  })
})
