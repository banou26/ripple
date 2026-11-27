import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const localScript = pkg.scripts?.['e2e:local']
if (!localScript) throw new Error('package.json has no "e2e:local" script')

const localSpecs = [...localScript.matchAll(/tests\/[\w.-]+\.spec\.ts/g)].map((match) => match[0])
const extraArgs = process.argv.slice(2)
const hasExplicitSpecs = extraArgs.some((arg) => /(?:^|\/)[\w.-]+\.spec\.ts$/.test(arg))
const args = ['playwright', 'test', '--forbid-only', '--project=webkit', ...(hasExplicitSpecs ? extraArgs : [...localSpecs, ...extraArgs])]

const result = spawnSync('npx', args, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.signal) {
  process.kill(process.pid, result.signal)
  process.exit(1)
}
process.exit(result.status ?? 1)
