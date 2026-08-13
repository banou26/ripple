// What an embedding page is allowed to ask /embed for, and what that means against a real file list.
//
// Kept pure and apart from the page so the grammar can be tested without an engine, a browser or a
// torrent. Everything here is total: a selection that names files this torrent does not have
// resolves to nothing rather than throwing, and the page says so.

export type EmbedMode = 'watch' | 'download'

/** An inclusive index span, always ascending. */
export type Span = { from: number, to: number }

/**
 * Selections stay DESCRIPTIVE until a file count is known.
 *
 * Nothing here holds one entry per selected file, because the width is attacker controlled: `files`
 * comes off a URL that an embedding page writes by hand, and `0-2000000000` is as easy to type as
 * `0-4`. Expanding at parse time turned that into a multi-GB renderer allocation, and
 * `0-9007199254740991` into a loop that never ends. Only `resolveSelection` expands anything, and it
 * expands against the torrent, so the cost is bounded by the number of files that actually exist.
 */
export type FileSelection =
  | { kind: 'all' }
  | { kind: 'single', index: number }
  | { kind: 'range', from: number, to: number }
  | { kind: 'list', spans: Span[] }

/**
 * `mode=download` opts in; anything else is the player.
 *
 * Absent has to keep meaning `watch`, because the one shipped consumer (@banou/stub-plugin) passes
 * only `magnet` and would otherwise stop playing the moment this lands.
 */
export const parseMode = (raw: string | undefined | null): EmbedMode =>
  raw?.trim().toLowerCase() === 'download' ? 'download' : 'watch'

const int = (raw: string): number | null => {
  // Number('') is 0 and Number(' 1 ') is 1, so neither is safe on a hand written query string
  if (!/^\d+$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}

/**
 * The `files` grammar: `all`, `3`, `0-4`, or a comma separated mix of the last two.
 *
 * `fileIndex` is the fallback so that adding `&mode=download` to an existing watch URL downloads the
 * file that URL was playing, which is the one translation an embedder should not have to think
 * about. With neither, a download page is for the whole torrent.
 */
export const parseFileSelection = (
  files: string | undefined | null,
  fileIndex: string | undefined | null,
): FileSelection => {
  const raw = files?.trim()
  if (!raw) {
    const single = fileIndex == null ? null : int(fileIndex)
    return single == null ? { kind: 'all' } : { kind: 'single', index: single }
  }
  if (raw.toLowerCase() === 'all') return { kind: 'all' }

  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  const spans: Span[] = []
  for (const part of parts) {
    const dash = part.indexOf('-')
    if (dash > 0) {
      const from = int(part.slice(0, dash))
      const to = int(part.slice(dash + 1))
      if (from == null || to == null) continue
      // normalised here, so a caller writing `4-0` is understood and nothing downstream has to care
      spans.push({ from: Math.min(from, to), to: Math.max(from, to) })
      continue
    }
    const one = int(part)
    if (one != null) spans.push({ from: one, to: one })
  }

  if (!spans.length) return { kind: 'all' }
  // arithmetic, never a materialised array: this is the number the old version paid for in memory
  const width = spans.reduce((n, s) => n + (s.to - s.from + 1), 0)
  // A lone `0-0` is a range the embedder wrote on purpose, but it names one file, and a selection of
  // one file is a file download rather than a zip of one. Shape follows the count, not the syntax.
  if (width === 1) return { kind: 'single', index: spans[0]!.from }
  if (spans.length === 1) return { kind: 'range', from: spans[0]!.from, to: spans[0]!.to }
  return { kind: 'list', spans }
}

/** The lowest index a selection could name, without expanding it. Used before the file list exists. */
export const firstIndexOf = (selection: FileSelection): number => {
  if (selection.kind === 'all') return 0
  if (selection.kind === 'single') return selection.index
  if (selection.kind === 'range') return selection.from
  // reduce, not Math.min(...spans): a spread passes one argument per element and blows the call
  // stack somewhere above 100k of them, which is a crash rather than a slow path
  return selection.spans.reduce((lowest, s) => Math.min(lowest, s.from), Number.MAX_SAFE_INTEGER)
}

/**
 * The selection against a torrent that actually has `fileCount` files.
 *
 * Sorted, de-duplicated, and with anything out of range dropped: an index the torrent does not have
 * is the embedder's mistake, and the page reports an empty result instead of quietly downloading
 * something else. Every expansion in here is clamped to the torrent FIRST, so the work and the
 * memory are bounded by the file count however wide the URL asked for.
 */
export const resolveSelection = (selection: FileSelection, fileCount: number): number[] => {
  if (fileCount <= 0) return []
  if (selection.kind === 'all') return [...Array(fileCount)].map((_, i) => i)
  if (selection.kind === 'single') {
    const { index } = selection
    return Number.isInteger(index) && index >= 0 && index < fileCount ? [index] : []
  }

  const spans = selection.kind === 'range' ? [{ from: selection.from, to: selection.to }] : selection.spans
  const picked = new Set<number>()
  for (const span of spans) {
    const from = Math.max(0, span.from)
    const to = Math.min(fileCount - 1, span.to)
    for (let i = from; i <= to; i++) picked.add(i)
  }
  return [...picked].sort((a, b) => a - b)
}
