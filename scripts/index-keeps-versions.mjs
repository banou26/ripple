#!/usr/bin/env node
// The gate between `fkn-sign pack --index` and the upload that REPLACES the host's index.
//
// `pack --index` merges, so the only way a release can take earlier versions off the host is an
// index it never read. A read that answers "The specified key does not exist" while the host is
// serving a standing index makes `packageIndexWith(null, ...)` write a document holding this release
// alone, the upload replaces the live index with it, and `verify --published` still passes, because
// it reads the version just published and finds it. Every earlier version of ripple is off the host
// and the job is green.
//
// WHY THIS ASKS FOR THE OUTCOME RATHER THAN THE `--remote` FLAG. wrangler 4 reading local storage is
// one way to reach that answer. A renamed key, another bucket, a token scoped elsewhere and a plain
// 404 are others, and every one of them answers the same sentence. So this compares the document
// about to be uploaded against TWO readings that share nothing: the index the release merged into,
// and the index the host is serving over HTTPS right now, which is a different credential and a
// different code path from wrangler's.
//
// Usage, one line per verdict on stdout or stderr, exit 1 on any refusal:
//
//   node scripts/index-keeps-versions.mjs --state <file> --standing <file> --merged <file>
//     --live <url> --slot <name> --version <version> [--wait <ms>]
//
//   --state     a file holding `held` or `absent`, written by the step that read the bucket
//   --standing  the index document as it was downloaded, read when the state is `held`
//   --merged    the document `pack --index` wrote, the one about to be uploaded
//   --live      where the host serves its index, read here as a second opinion on --state
//   --wait      between the three reads of --live, default 2000ms

import { readFileSync } from 'node:fs'

/** How many bytes an index may be, matching @fkn/sign's INDEX_MAX_BYTES. */
const INDEX_MAX_BYTES = 65_536

const HOW_MANY_READS = 3

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const flagsOf = (argv) => {
  const flags = {}
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at]
    const value = argv[at + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      fail(`'${argv.join(' ')}' is not a list of --flag value pairs`)
    }
    flags[name.slice(2)] = value
  }
  return flags
}

/** Every `<slot>@<version>` an index document names, which is the fact being compared. */
const entriesOf = (index) => {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) throw new Error('not a JSON object')
  const packages = index.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('carries no packages object')
  return Object
    .entries(packages)
    .flatMap(([slot, held]) => Object.keys(held?.versions ?? {}).map((version) => `${slot}@${version}`))
    .sort()
}

const documentAt = (path, what) => {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`${what} could not be read at ${path}: ${error.message}`)
  }
  try {
    return entriesOf(JSON.parse(text))
  } catch (error) {
    fail(`${what} at ${path} is ${error.message}`)
  }
}

/**
 * The index the host is serving, read up to three times.
 *
 * `{ entries }` is a document that was read, `{ none }` a host that serves no index, and `{ why }`
 * a reading that did not happen at all, which is only ever the absence of an answer rather than an
 * answer. A 404 is the Function saying the key is not in the bucket, which is a fact; a 5xx, a
 * redirect and an unreachable host are not.
 */
const liveIndex = async (url, wait) => {
  let last = 'no read was attempted'
  for (let attempt = 1; attempt <= HOW_MANY_READS; attempt += 1) {
    if (attempt > 1 && wait > 0) await new Promise((wake) => setTimeout(wake, wait))
    let response
    try {
      // a timeout, because a host that accepts the connection and never answers would otherwise
      // hold the job open for the whole of its remaining budget
      response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      last = `${url} is unreachable: ${error.message}`
      continue
    }
    if (response.status === 404) return { none: `${url} answered 404, so the host serves no index` }
    const body = (await response.text()).trim()
    if (!response.ok) {
      last = `${url} answered ${response.status}: ${body.slice(0, 200)}`
      // a 4xx is an answer about this request and reading it again says the same
      if (response.status < 500) return { why: last }
      continue
    }
    if (body.length > INDEX_MAX_BYTES) return { why: `${url} answered ${body.length} bytes, over the ${INDEX_MAX_BYTES} byte cap on an index` }
    try {
      return { entries: entriesOf(JSON.parse(body)) }
    } catch (error) {
      return { why: `${url} answered 200 with something that is ${error.message}` }
    }
  }
  return { why: last }
}

const flags = flagsOf(process.argv.slice(2))
for (const name of ['state', 'standing', 'merged', 'live', 'slot', 'version']) {
  if (flags[name] === undefined) fail(`--${name} is required`)
}

const wait = flags.wait === undefined ? 2000 : Number(flags.wait)
if (!Number.isFinite(wait) || wait < 0) fail(`--wait is milliseconds, and '${flags.wait}' is not`)

let state
try {
  state = readFileSync(flags.state, 'utf8').trim()
} catch (error) {
  // never a skip: with no record of what the read answered there is nothing to hold the merge to
  fail(`nothing recorded what the bucket read answered, at ${flags.state}: ${error.message}`)
}
if (state !== 'held' && state !== 'absent') fail(`the record of the bucket read reads '${state}', which is neither 'held' nor 'absent'`)

const merged = documentAt(flags.merged, 'the packed index')
const own = `${flags.slot}@${flags.version}`
if (!merged.includes(own)) fail(`the packed index names ${merged.join(' ') || 'nothing'}, and not ${own}, which is the release this is`)

const live = await liveIndex(flags.live, wait)

if (state === 'held') {
  const standing = documentAt(flags.standing, 'the index this release merged into')
  const dropped = standing.filter((entry) => !merged.includes(entry))
  if (dropped.length > 0) fail(`the packed index drops ${dropped.join(' ')}, which the index it merged into listed`)
  if (live.entries !== undefined) {
    const unserved = live.entries.filter((entry) => !merged.includes(entry))
    if (unserved.length > 0) fail(`the packed index drops ${unserved.join(' ')}, which ${flags.live} is serving`)
    console.log(`the packed index keeps all ${live.entries.length} entries the host serves and adds ${own}`)
  } else {
    console.log(`the packed index keeps all ${standing.length} entries it merged into and adds ${own}; ${live.none ?? live.why}`)
  }
} else {
  if (live.entries !== undefined) {
    fail(`the bucket read found no index while ${flags.live} serves ${live.entries.join(' ') || 'an index'}, so the read did not read the bucket the host serves`)
  }
  if (live.why !== undefined) fail(`the bucket read found no index and nothing confirms that: ${live.why}`)
  if (merged.length !== 1) {
    fail(`no index was read, so the packed one carries ${own} alone, and it carries ${merged.join(' ')}`)
  }
  console.log(`no index anywhere yet, and the packed one carries ${own} alone: ${live.none}`)
}
