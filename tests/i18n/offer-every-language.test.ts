import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { offerEveryLanguage, PSEUDO } from '../languages'

// tests/languages.ts's plugin, through the hooks vite calls on a spec build

const ROOT = join(__dirname, '../..')
const OFFERED = join(ROOT, 'src/i18n/offered.json')
const CORE = join(ROOT, 'src/i18n/index.ts')
const VIRTUAL = '\0ripple-pseudo-language'

const plugin = offerEveryLanguage() as unknown as {
  resolveId: (source: string) => string | undefined
  load: (id: string) => string | undefined
  transform: (code: string, id: string) => string | undefined
}

test('a spec build offers English, every catalogue in src/locales and the pseudo-language', () => {
  const catalogues = readdirSync(join(ROOT, 'src/locales')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length))
  expect(JSON.parse(plugin.load(OFFERED) ?? '')).toEqual(['en', ...catalogues, PSEUDO])
  expect(plugin.load(join(ROOT, 'src/i18n/languages.ts'))).toBeUndefined()
})

test('the pseudo-language is one more catalogue the core loads by its path', () => {
  const code = plugin.transform(readFileSync(CORE, 'utf8'), CORE) ?? ''
  expect(code).toContain(`'../locales/${PSEUDO}.json': () => import('${VIRTUAL}')`)
  expect(plugin.resolveId(VIRTUAL)).toBe(VIRTUAL)
  expect(plugin.load(VIRTUAL)).toMatch(/^export default \{/)
  expect(plugin.transform(code, join(ROOT, 'src/index.tsx'))).toBeUndefined()
}, 60_000)

test('a core that loads its catalogues another way stops the spec build, rather than offering nothing', () => {
  expect(() => plugin.transform("const CATALOGUES = import.meta.glob<Catalogue>('../locales/*.json')", CORE)).toThrow(/no longer loads its catalogues/)
})
