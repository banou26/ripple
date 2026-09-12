// The package index and the archives an `https-pkg:torrent.fkn.app/ripple` source is read from,
// served out of R2 rather than out of the build output.
//
// THIS EXISTS BECAUSE CLOUDFLARE PAGES IGNORES RANGE ON A STATIC FILE (measured 2026-09-12; npm and
// unpkg answered 206 as the control). The loading side reads a zip by asking for its tail, then its
// central directory, then one two-sided range per file it actually wants, and it accepts a 200 where
// it asked for a 206 only when the body is exactly the size the index promised. So a host that
// ignores Range does not degrade, it costs the whole archive on every boot.
//
// WHAT REACHES IT IS `src/_routes.json`, copied to build/ by `copy-html`. A `_middleware` at the
// functions root is otherwise invoked for EVERY request, and Cloudflare does not apply `_headers` to
// a Function's response, so the `/add` frame headers would come off the site the day this deployed.
// The `next()` below is the fallthrough for a path that slips through the route list, never the
// mechanism the site is served by.

/** An R2 range read: an offset with a length, or the last `suffix` bytes. */
type R2Range = { offset: number, length: number } | { suffix: number }

/** What an R2 object reports. `size` is the WHOLE object's, whatever range was asked for. */
type R2Head = { size: number, httpEtag: string }

type R2Body = R2Head & { body: ReadableStream }

/** The slice of the `PACKAGES` binding this uses: one ranged read, and one metadata read. */
export type PackagesBucket = {
  get: (key: string, options?: { range?: R2Range }) => Promise<R2Body | null>
  head: (key: string) => Promise<R2Head | null>
}

/**
 * A Pages Functions middleware invocation, structurally.
 *
 * Declared here rather than pulled from `@cloudflare/workers-types`: three fields and two bucket
 * methods is the whole surface, and the tests hand it a fake bucket of exactly this shape.
 */
export type MiddlewareContext = {
  request: Request
  env: { PACKAGES?: PackagesBucket }
  next: () => Promise<Response>
}

/** Where a reader looks for a host's index. `INDEX_PATH` in @fkn/sign, restated: no import here. */
const INDEX_PATH = '/.well-known/fkn-package.json'

const ARCHIVE_PREFIX = '/packages/'

/** ONE path segment: no `/`, and no leading dot, so nothing under the prefix can name another key. */
const ARCHIVE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/

/** Every key this app owns in the shared bucket. */
const KEY_PREFIX = 'ripple/'

/** The broker is always fkn.app, nested or not, so one origin is the whole list. */
const ALLOW_ORIGIN = 'https://fkn.app'

type Kind = 'index' | 'archive'

type Target = { key: string, kind: Kind }

/** The bucket key a request names, or null for a path this Function does not serve. */
const targetOf = (pathname: string): Target | null => {
  if (pathname === INDEX_PATH) return { key: `${KEY_PREFIX}index.json`, kind: 'index' }
  if (!pathname.startsWith(ARCHIVE_PREFIX)) return null
  const file = pathname.slice(ARCHIVE_PREFIX.length)
  if (!ARCHIVE_FILE.test(file) || file.includes('..')) return null
  return { key: `${KEY_PREFIX}${file}`, kind: 'archive' }
}

/**
 * CORS on every answer, the refusals included.
 *
 * A header left off a 404 does not read as a 404: the browser hides the status behind a network
 * error, so an ABSENT index arrives as an UNREACHABLE one, and those are opposite verdicts. Absent
 * is a host that serves no package and the boot moves on; unreachable is what sends a verified
 * package to its stored copy. The relay refuses `*.fkn.app`, so there is no second path to fall to.
 */
const corsOf = (kind: Kind): Record<string, string> => ({
  'access-control-allow-origin': ALLOW_ORIGIN,
  ...(kind === 'archive' ? { 'access-control-expose-headers': 'Content-Range, Accept-Ranges' } : {}),
})

const headersOf = (kind: Kind, etag: string): Record<string, string> =>
  kind === 'index'
    ? { ...corsOf(kind), 'content-type': 'application/json', 'cache-control': 'max-age=300', etag }
    : {
        ...corsOf(kind),
        'content-type': 'application/zip',
        // the version is in the name, so an archive is never the thing that changed
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
        etag,
      }

const refuse = (status: number, kind: Kind, message: string, headers: Record<string, string> = {}): Response =>
  new Response(`${message}\n`, {
    status,
    headers: { ...corsOf(kind), 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

const missing = (target: Target): Response => refuse(404, target.kind, `no ${target.key} in the packages bucket`)

type Slice = { start: number, end: number }

/**
 * `bytes=a-b` (what the reader sends), `bytes=a-` and `bytes=-n`, resolved against a known size.
 *
 * null is a header this IGNORES, which answers the whole object: a Range nobody can parse is not a
 * reason to refuse a request a static host would have served whole anyway.
 */
const sliceOf = (header: string, size: number): Slice | 'unsatisfiable' | null => {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (asked === null) return null
  const from = asked[1] ?? ''
  const to = asked[2] ?? ''
  if (from === '' && to === '') return null
  if (from === '') {
    const length = Number(to)
    return length === 0 ? 'unsatisfiable' : { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(from)
  if (start >= size) return 'unsatisfiable'
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  return end < start ? 'unsatisfiable' : { start, end }
}

const wholeObject = async (bucket: PackagesBucket, target: Target): Promise<Response> => {
  const object = await bucket.get(target.key)
  if (object === null) return missing(target)
  return new Response(object.body, {
    status: 200,
    headers: { ...headersOf(target.kind, object.httpEtag), 'content-length': String(object.size) },
  })
}

export const onRequest = async ({ request, env, next }: MiddlewareContext): Promise<Response> => {
  const target = targetOf(new URL(request.url).pathname)
  if (target === null) return next()

  if (request.method === 'OPTIONS') {
    // no preflight is expected for a two-sided Range, which is safelisted. This is insurance against
    // a build that sends one: a refused preflight would surface as an unreachable host.
    return new Response(null, {
      status: 204,
      headers: {
        ...corsOf(target.kind),
        'access-control-allow-methods': 'GET, HEAD',
        'access-control-allow-headers': 'Range',
        'access-control-max-age': '86400',
      },
    })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return next()

  const bucket = env.PACKAGES
  // without this a project missing the binding answers the SPA fallback, and an index.html parsed as
  // an index is an ABSENT index: the misconfiguration would read as a host that serves no packages
  if (bucket === undefined) return refuse(503, target.kind, 'the PACKAGES R2 binding is not bound to this project')

  if (request.method === 'HEAD') {
    // Range is not honoured on a HEAD: nothing reads a zip that way, and the size is the fact a HEAD asks for
    const head = await bucket.head(target.key)
    if (head === null) return missing(target)
    return new Response(null, {
      status: 200,
      headers: { ...headersOf(target.kind, head.httpEtag), 'content-length': String(head.size) },
    })
  }

  const asked = request.headers.get('range')
  if (asked === null) return wholeObject(bucket, target)

  const head = await bucket.head(target.key)
  if (head === null) return missing(target)
  const slice = sliceOf(asked, head.size)
  if (slice === null) return wholeObject(bucket, target)
  if (slice === 'unsatisfiable') {
    return refuse(416, target.kind, `'${asked}' is not a range of a ${head.size} byte object`, {
      'content-range': `bytes */${head.size}`,
    })
  }

  const length = slice.end - slice.start + 1
  const object = await bucket.get(target.key, { range: { offset: slice.start, length } })
  if (object === null) return missing(target)
  return new Response(object.body, {
    status: 206,
    headers: {
      ...headersOf(target.kind, object.httpEtag),
      'content-range': `bytes ${slice.start}-${slice.end}/${head.size}`,
      'content-length': String(length),
    },
  })
}
