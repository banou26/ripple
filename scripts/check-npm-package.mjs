#!/usr/bin/env node
// The gate on what gets published, run by `npm run build` right after the manifest is written.
//
// Nothing else in this repo observes the package: torrent.fkn.app serves build/ as a SITE, where
// every absolute path is correct by construction, and the suites drive that site. So 0.0.7 published
// a package whose entry named three files that were not where it said, every check stayed green, and
// the only symptom was https://fkn.app/app/npm:@banou/ripple reporting "The download engine stopped"
// with a 404 on /assets/worker-SJZDGuG-.js behind it.
//
// Each rule pins one thing that was measured broken.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** a static or dynamic ES import, which is what makes the entry a module rather than a script */
const ES_MODULE = /(?:^|[\s;}])(?:import|export)\s*[{*"'(]|(?:^|[\s;}])(?:import|export)\s+\w/

/** an origin-absolute path naming a file the package must carry */
const ABSOLUTE_ASSET = /["'`](\/[A-Za-z0-9_\-./@]*\.(?:js|mjs|wasm|woff2|png|svg|torrent|css))["'`]/g

/**
 * Files the entry reaches by building a url at runtime, so no scan of it can see them.
 *
 * `embed.tsx` and `use-thumbnails.ts` compose these from an origin and a directory
 * (`new URL('worker.js', jassubBase)`), which is why a missing one would surface as a dead player
 * rather than as a broken build.
 */
const RESOLVED_AT_RUNTIME = [
  'libav-worker.js',
  'libav.wasm',
  'libav-jspi.wasm',
  'jassub/worker.js',
  'jassub/jassub-worker.wasm',
  'jassub/jassub-worker-modern.wasm',
  'jassub/default.woff2',
]

/**
 * Every reason this directory would not load as an app, worst first. An empty array is a pass.
 *
 * @param pkg   the parsed package.json that ships WITH the build, not the repo's
 * @param repo  the repo's own package.json, which the shipped one must agree with
 * @param tree  `{ read(path), exists(path) }` over the directory being published
 * @returns {string[]} one line per problem, each naming the file it is about
 */
export const packageProblems = (pkg, repo, tree) => {
  const problems = []

  for (const field of ['name', 'version']) {
    if (pkg[field] !== repo[field]) {
      problems.push(`the published ${field} is ${JSON.stringify(pkg[field])} and the repo's is ${JSON.stringify(repo[field])}. Rebuild rather than publishing a stale manifest.`)
    }
  }
  if (pkg.repository?.url !== repo.repository?.url) {
    problems.push(`the published repository.url is ${JSON.stringify(pkg.repository?.url)} and the repo's is ${JSON.stringify(repo.repository?.url)}, which is what provenance compares the upload against`)
  }

  const main = pkg.main
  if (typeof main !== 'string' || !main.trim()) {
    return [...problems, 'package.json declares no "main", so the platform has no module to load']
  }
  if (main.includes('/')) {
    problems.push(`"main" is ${JSON.stringify(main)}, so the entry sits below the package root while the app's own paths are absolute. The platform maps a tenant path 1:1 onto a package path, so every one of them would be a directory too deep.`)
  }

  const code = tree.read(main)
  if (code === undefined) {
    problems.push(`${main} does not exist. package.json names it as "main" and the platform loads exactly that file.`)
    return problems
  }
  if (!code.trim()) {
    problems.push(`${main} is empty`)
    return problems
  }
  if (!ES_MODULE.test(code)) {
    problems.push(`${main} carries no import or export, so <script type="module"> would load a script that exports nothing`)
  }

  // the class 0.0.7 shipped: an absolute path is a package path here, so it has to resolve here
  for (const path of new Set([...code.matchAll(ABSOLUTE_ASSET)].map((m) => m[1]))) {
    if (!tree.exists(path.slice(1))) {
      problems.push(`${main} names ${path}, which the package does not carry. A tenant fetches that path from the package root, so it has to be there.`)
    }
  }

  for (const path of RESOLVED_AT_RUNTIME) {
    if (!tree.exists(path)) problems.push(`${path} is missing, and the entry builds its url at runtime so nothing else would notice`)
  }

  // the app's identity, fetched from the package root by the platform and from /.well-known/ by a
  // host. Its absence is SWALLOWED there (`recordManifest(...).catch(() => {})`), so the app simply
  // runs unregistered and nothing says why.
  for (const path of ['fkn.json', '.well-known/fkn.json']) {
    if (!tree.exists(path)) problems.push(`${path} is missing, so the app has no identity from this source. \`fkn-sign place --out <dir>\` writes both.`)
  }

  return problems
}

/** Reads a directory for the checks above: undefined for a missing file, false for a missing path. */
export const readTree = (root) => ({
  read: (path) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined,
  exists: (path) => existsSync(join(root, path)) && statSync(join(root, path)).size >= 0,
})

const isMain = process.argv[1]?.endsWith('check-npm-package.mjs')
if (isMain) {
  const dir = process.argv[2] ?? 'build'
  const repo = JSON.parse(readFileSync('package.json', 'utf8'))
  const tree = readTree(dir)
  const shipped = tree.read('package.json')
  if (shipped === undefined) {
    console.error(`${dir}/package.json does not exist, so there is nothing to publish. Run write-npm-manifest.mjs first.`)
    process.exit(1)
  }
  const problems = packageProblems(JSON.parse(shipped), repo, tree)
  if (problems.length) {
    console.error(`${resolve(dir)} cannot be loaded as an app:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`${dir}/${JSON.parse(shipped).main} is an ES module the platform can load, and every path it names is in the package`)
}
