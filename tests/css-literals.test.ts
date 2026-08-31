import { describe, expect, it } from 'vitest'

/**
 * A backtick inside an emotion `css` template literal ENDS THE STRING.
 *
 * Everything after it becomes code, so a comment that mentions `svg` or `max-width` in backticks
 * silently swallows the rest of the file. What comes back is a parse error tens of lines below the
 * real cause, naming a semicolon:
 *
 *     Expected a semicolon or an implicit semicolon after a statement, but found none
 *
 * `vpn-stat.tsx` has carried a warning about this in its own css block for months and it was still
 * made three times in one afternoon, in three different files, twice by somebody who had just read
 * that warning. A note in one file cannot protect the others; this can.
 *
 * A unit test rather than a lint rule because this repo's eslint config is absent, so a rule would
 * be a file nothing runs. This runs with everything else.
 */

/*
 * Read through Vite rather than through `node:fs`.
 *
 * The unit project runs with `vite-plugin-node-stdlib-browser`, which replaces node's built-ins with
 * browser shims, so `readdirSync` is present as a name and is not a function. `import.meta.glob` is
 * resolved at build time by the bundler and works wherever the test does.
 */
const SOURCES = import.meta.glob(
  /*
   * BOTH trees, and the second one is not padding.
   *
   * The tests moved out of src, and this glob followed them by scanning only src, which quietly
   * dropped one file from the sweep: `vpn-stat.browser.test.tsx` carries a css block, and it is the
   * very file whose comment has warned about this trap since before the guard existed. A test file
   * renders components and writes css exactly like anything else, so it can make the mistake exactly
   * like anything else, and a guard that stops at a directory boundary is a guard with a blind spot
   * nobody would think to look in.
   *
   * The count going 24 to 23 is what caught it. A checker losing a case reports success.
   */
  ['../src/**/*.{ts,tsx}', './**/*.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

/**
 * Every css literal in a file, with the text that FOLLOWS its closing backtick.
 *
 * The close is taken as the first backtick, which is exactly what the parser does, so a literal cut
 * short by a stray one ends early here too. What gives it away is not the body, which by
 * construction never contains a backtick, but what comes next: after a real close the next thing is
 * a delimiter, and after a false one it is the rest of somebody's sentence.
 *
 * THE FIRST VERSION OF THIS CHECKED THE BODY and could not fail. Injecting the exact mistake into
 * vpn-stat.tsx left all 24 tests green, because the body it extracted stopped at the stray backtick
 * and contained nothing suspicious. A checker is a claim about the checker first.
 */
/**
 * Where a template literal starting at `start` really ends.
 *
 * An ESCAPED backtick does not close it, and `embed.tsx` has three of them: its css block explains
 * the player's own `title` element and writes the word in escaped backticks, which is exactly the
 * right way to say it. A scanner that stopped at the first backtick called that a mistake, which is
 * a checker inventing work rather than finding it.
 */
const closeOf = (source: string, start: number): number => {
  for (let at = start; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue }
    if (source[at] === '`') return at
  }
  return -1
}

const cssLiterals = (source: string): { body: string, after: string }[] => {
  const out: { body: string, after: string }[] = []
  for (let at = source.indexOf('css`'); at >= 0; at = source.indexOf('css`', at + 1)) {
    const start = at + 'css`'.length
    const end = closeOf(source, start)
    if (end < 0) { out.push({ body: source.slice(start), after: '' }); break }
    out.push({ body: source.slice(start, end), after: source.slice(end + 1, end + 40) })
  }
  return out
}

/**
 * What may legally follow a css literal: a delimiter, or the end of the line.
 *
 * A css literal is an expression, so it is followed by a close paren, a comma, a semicolon, a brace,
 * a backtick opening the next one, or the end of the line. Prose is what a stray backtick leaves
 * behind, and prose is never any of those.
 *
 * The newline is spelled out rather than left to `$`, which without the `m` flag means the end of
 * the whole FILE and matched nothing: every real file failed at once, which is at least the failure
 * that gets noticed.
 */
const CLOSES = /^[ \t]*([),;}`]|\r?\n|$)/

describe('no backtick may appear inside a css template literal', () => {
  const files = Object.entries(SOURCES).filter(([, source]) => source.includes('css`'))

  it('finds the files that actually carry css literals, so this checks something', () => {
    // a floor, not a count: new styled components are added all the time and should not fail this
    expect(files.length).toBeGreaterThan(10)
  })

  for (const [path, source] of files) {
    it(`${path} keeps its css literals closed`, () => {
      for (const [index, { body, after }] of cssLiterals(source).entries()) {
        const line = after.split('\n')[0]!
        expect(
          CLOSES.test(after),
          `css literal ${index} in ${path} is followed by ${JSON.stringify(line)} rather than by a `
          + 'delimiter, which means a backtick inside it ended the string early. Everything after '
          + 'that point is being parsed as code.',
        ).toBe(true)

        // the second net: a literal that ran past its end has eaten real code
        expect(body, `css literal ${index} in ${path} swallowed an export`)
          .not.toMatch(/\bexport (const|default|function|type)\b/)
      }
    })
  }
})
