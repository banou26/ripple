#!/usr/bin/env node
// Writes build/package.json, which turns the built site into the npm package.
//
// THE PACKAGE ROOT IS THE SITE ROOT, and that is the whole point. The platform maps a tenant path
// 1:1 onto a package path (fkn-client, web/src/sources/package-files.ts: "tenant paths map 1:1 onto
// package paths"), so an app that asks for `/libav-worker.js` gets `<package>/libav-worker.js`.
// Ripple asks with absolute paths because on torrent.fkn.app the origin root IS build/, and those
// same paths have to keep meaning the same thing inside a package. Publishing the repo root instead
// puts every one of them a directory too deep: 0.0.7 shipped that way and the engine died on a 404
// for `/assets/worker-SJZDGuG-.js` (2026-09-11).
//
// Only the fields a consumer or the platform reads are carried over. No dependencies: the app is
// bundled, and unpkg installs nothing. No scripts: there is nothing to run in a built site.

import { readFileSync, writeFileSync } from 'node:fs'

const KEPT = ['name', 'version', 'type', 'repository', 'keywords', 'license', 'description', 'homepage']

/** The manifest that ships beside the built site, given the repo's own. `main` is always the entry
 *  at the root of that directory, whatever the repo calls its build output. */
export const npmManifest = (pkg, entry = 'index.js') => ({
  ...Object.fromEntries(KEPT.filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]])),
  main: entry,
})

const isMain = process.argv[1]?.endsWith('write-npm-manifest.mjs')
if (isMain) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const out = npmManifest(pkg)
  writeFileSync('build/package.json', `${JSON.stringify(out, null, 2)}\n`)
  console.log(`build/package.json: ${out.name} ${out.version}, main ${out.main}`)
}
