import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect, test } from 'vitest'

// a page in Arabic or Hebrew mirrors only what its CSS names by start and end, so one `margin-left` shows as a bug only to a
// viewer of those languages, long after it merged
const ROOT = join(import.meta.dirname, '..')

// the legal pages stay in English, left to right
const LEFT_TO_RIGHT = ['src/components/legal-doc.tsx']
// physical on purpose: the player's top row clears each side's own safe area, with the same room on both; a menu's
// place in the window, which its placement mirrors itself; a centred toast, whose translate is physical too
const TRULY_PHYSICAL: Record<string, string[]> = {
  'src/router/embed.tsx': [
    'padding-left: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-left, 0px))',
    'padding-right: calc(calc(1.6 * var(--mp-unit)) + env(safe-area-inset-right, 0px))',
    'padding-left: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-left, 0px))',
    'padding-right: calc(calc(2.4 * var(--mp-unit)) + env(safe-area-inset-right, 0px))',
  ],
  'src/components/menu.tsx': ['style={{ left: pos.x'],
}

const PHYSICAL = /(?<![\w-])(?:(?:left|right|float|clear|(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)(?:-\w+)?)\s*:\s*[^;}]+|text-align:\s*(?:left|right)\b|linear-gradient\(\s*(?:90deg|270deg|to (?:left|right)\b)|translateX\([^)]*\)|translate:\s*[^;}]+)/g
// a shorthand whose left and right differ, or a corner rounded unlike its mirror
const SHORTHAND = /(?<![\w-])(?:margin|padding|inset|border-width|border-radius)\s*:\s*([^;}]+)/g
const PHYSICAL_STYLE = /\b(?:margin|padding|border)(?:Left|Right)\w*\s*:|\btextAlign:\s*['"](?:left|right)|\bstyle=\{\{[^}]*\b(?:left|right):\s*[^,}]+/g

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name))
  : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)]
  : [])

// a value's parts, split at the spaces outside its brackets
const partsOf = (value: string) => {
  const parts = ['']
  let depth = 0
  for (const char of value.replace(/!important/, '').trim()) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0
    if (depth === 0 && /\s/.test(char)) { if (parts.at(-1)) parts.push('') } else parts[parts.length - 1] += char
  }
  return parts
}

const lopsided = (property: string, value: string) => {
  const parts = partsOf(value)
  if (property === 'border-radius') return !value.includes('/') && new Set(parts).size > 1
  return parts.length === 4 && parts[1] !== parts[3]
}

/**
 * Each physical declaration of `code`'s css templates and style objects, and each gradient running along the line
 * anywhere in it: but a centred element's `left: 50%` and the translate that pulls it back by half its width.
 */
const physicalIn = (code: string) => [
  // each template up to its first unescaped backtick, a nested one's too, as the lookahead lets matches overlap
  ...[...code.matchAll(/(?:css|keyframes)`(?=((?:\\[\s\S]|[^\\`])*)`)/g)].flatMap(([, template]) => {
    const declarations = template!.replace(/\/\*[\s\S]*?\*\//g, '')
    return [
      ...(declarations.match(PHYSICAL) ?? []).filter(found => !found.startsWith('linear-gradient')),
      ...[...declarations.matchAll(SHORTHAND)].filter(([found, value]) => lopsided(found.split(':')[0]!.trim(), value!)).map(([found]) => found.trim()),
    ]
  }),
  ...(code.replace(/\/\*[\s\S]*?\*\//g, '').match(/linear-gradient\(\s*(?:90deg|270deg|to (?:left|right)\b)/g) ?? []),
  ...code.match(PHYSICAL_STYLE) ?? [],
].map(found => found.trim()).filter(found => !/^left:\s*50%/.test(found) && !/^translateX\(-50%\)$/.test(found))

test('the page names its sides by start and end, but what stays left to right', () => {
  const found = sources(join(ROOT, 'src')).flatMap(file => {
    const path = relative(ROOT, file)
    if (LEFT_TO_RIGHT.includes(path)) return []
    return physicalIn(readFileSync(file, 'utf8'))
      .filter(declaration => !TRULY_PHYSICAL[path]?.includes(declaration))
      .map(declaration => `${path}: ${declaration}`)
  })
  expect(found).toEqual([])
})

// a css template's source, written so that this file holds no template tests/css-literals.test.ts would read as one
const template = (body: string) => ['css', body, ''].join('`')

test('the control: each form is found, in a comment none', () => {
  expect(physicalIn(template('/* left: 1rem */ margin-left: 1rem; .a { right: 0; } text-align: right; border-left-color: red; left: 50%; margin-inline-start: 1rem; float: left;')))
    .toEqual(['margin-left: 1rem', 'right: 0', 'text-align: right', 'border-left-color: red', 'float: left'])
  expect(physicalIn(template('padding: 4px 8px 4px 12px; padding: 4px 8px; margin: 0 8px 0 8px; border-radius: 0 4px 4px 0; border-radius: 4px; border-radius: calc(0.6 * var(--unit)) !important; inset: 0 auto 0 0;')))
    .toEqual(['padding: 4px 8px 4px 12px', 'border-radius: 0 4px 4px 0', 'inset: 0 auto 0 0'])
  expect(physicalIn(`${template('transform: translateX(14px); transform: translateX(-50%); translate: 4px 0;')} const band = 'linear-gradient(90deg, red, blue)'; const up = 'linear-gradient(to top, red, blue)'`))
    .toEqual(['translateX(14px)', 'translate: 4px 0', 'linear-gradient(90deg'])
  expect(physicalIn('<a style={{ marginLeft: 1, marginInlineStart: 2 }}/><a style={{ width: 1, left: 0 }}/><a style={{ textAlign: \'right\' }}/>'))
    .toEqual(['marginLeft:', 'style={{ width: 1, left: 0', 'textAlign: \'right'])
})
