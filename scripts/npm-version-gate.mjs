#!/usr/bin/env node
// Whether a version number can still be published, asked of the WHOLE packument rather than of the
// version document.
//
// A 404 on the version document is not proof that a number is free. npm tombstones an unpublished
// version: the document is gone, `versions` no longer carries it, and the registry still refuses the
// upload with "Cannot publish over previously published version". @banou/ripple walked into exactly
// that on 0.0.6 (2026-09-11, published 2025-03-17 and unpublished a minute later): the gate read
// 404, the whole build ran, the provenance statement was SIGNED INTO THE PUBLIC TRANSPARENCY LOG,
// and only then did the PUT come back 400. `time` is what keeps the complete history, unpublished
// numbers included, so it is the only field that can answer this before a signature is spent.
//
// No imports on purpose: `fetch` and `process` are globals, and the unit test project runs its
// modules through vite's node-stdlib-browser polyfill, where `node:fs` fails resolving punycode.

/**
 * What to do about `version`, given the registry's document for the package.
 *
 * @param packument the parsed packument, or null when the registry serves no such package
 * @param version   the version package.json names
 * @returns {{ action: 'publish' | 'skip' | 'refuse', reason: string }}
 */
export const decide = (packument, version) => {
  if (!packument) return { action: 'publish', reason: 'the registry serves no package under this name yet' }
  if (packument.versions?.[version]) return { action: 'skip', reason: `${version} is already published` }
  if (packument.time?.[version]) {
    return {
      action: 'refuse',
      reason: `${version} was published on ${packument.time[version]} and unpublished. npm keeps the number reserved forever, so this publish would fail after the provenance statement is already signed. Bump the version.`,
    }
  }
  return { action: 'publish', reason: `${version} has never been used` }
}

/** The packument, or null for a package the registry has never carried. Throws on anything else. */
export const fetchPackument = async (name) => {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}. Refusing to guess.`)
  return response.json()
}

// stdout carries key=value for $GITHUB_OUTPUT and nothing else; the prose goes to stderr
if (process.argv[1]?.endsWith('npm-version-gate.mjs')) {
  const [name, version] = process.argv.slice(2)
  if (!name || !version) {
    console.error('usage: npm-version-gate.mjs <package name> <version>')
    process.exit(1)
  }
  const { action, reason } = decide(await fetchPackument(name), version)
  console.error(`${name} ${version}: ${action}, ${reason}`)
  if (action === 'refuse') process.exit(1)
  console.log(`changed=${action === 'publish'}`)
}
