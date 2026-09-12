import { describe, expect, it } from 'vitest'

import pkg from '../../package.json'

import { onRequest } from '../../functions/_middleware'

/**
 * The Pages Function that serves the package index and the archives out of R2.
 *
 * None of this can be observed from the site: torrent.fkn.app serves build/ as a website, and the
 * only reader of these two paths is the platform's zip reader, which asks for a tail, a central
 * directory and then one two-sided range per file. A Function that answered 200 to each of those
 * would still boot a package, by downloading the whole archive every time; one that answered a range
 * off by a byte would fail a CRC with nothing naming the cause. So the slice, the Content-Range and
 * the header sets are asserted against bytes rather than read.
 *
 * The fake bucket LOGS its calls, because two of the rules here are about a read that must never
 * happen: a nested path under /packages/ and a name carrying `..` have to be refused before a key is
 * built, and a 404 from the bucket would look exactly like a refusal that worked.
 */

const encoder = new TextEncoder()

/** stands in for a zip: only its length and its slices are ever read here */
const ARCHIVE = new Uint8Array(Array.from({ length: 256 }, (_, at) => at))

const INDEX = encoder.encode('{"v":1,"default":"ripple","packages":{}}')

const ARCHIVE_KEY = 'ripple/ripple-0.0.12.zip'

const ARCHIVE_PATH = '/packages/ripple-0.0.12.zip'

const INDEX_PATH = '/.well-known/fkn-package.json'

/** what the Function answers when it hands the request to the static asset pipeline */
const NEXT = 'the static pipeline answered'

type Range = { offset: number, length: number } | { suffix: number }

type Call = { op: 'get' | 'head', key: string, range: Range | null }

const streamOf = (bytes: Uint8Array): ReadableStream => new ReadableStream({
  start (controller) {
    controller.enqueue(bytes)
    controller.close()
  },
})

const bucketOf = (objects: Record<string, Uint8Array>) => {
  const calls: Call[] = []
  return {
    calls,
    bucket: {
      head: async (key: string) => {
        calls.push({ op: 'head', key, range: null })
        const bytes = objects[key]
        return bytes === undefined ? null : { size: bytes.byteLength, httpEtag: `"etag-${key}"` }
      },
      get: async (key: string, options?: { range?: Range }) => {
        const range = options?.range ?? null
        calls.push({ op: 'get', key, range })
        const bytes = objects[key]
        if (bytes === undefined) return null
        const slice = range === null
          ? bytes
          : 'suffix' in range
            ? bytes.subarray(bytes.byteLength - range.suffix)
            : bytes.subarray(range.offset, range.offset + range.length)
        return { size: bytes.byteLength, httpEtag: `"etag-${key}"`, body: streamOf(slice) }
      },
    },
  }
}

const answer = async (
  path: string,
  { method = 'GET', range, objects, bind = true }: {
    method?: string
    range?: string
    objects?: Record<string, Uint8Array>
    bind?: boolean
  } = {},
) => {
  const { calls, bucket } = bucketOf(objects ?? { 'ripple/index.json': INDEX, [ARCHIVE_KEY]: ARCHIVE })
  let nexted = false
  const response = await onRequest({
    request: new Request(`https://torrent.fkn.app${path}`, {
      method,
      ...(range === undefined ? {} : { headers: { range } }),
    }),
    env: bind ? { PACKAGES: bucket } : {},
    next: async () => {
      nexted = true
      return new Response(NEXT, { status: 200 })
    },
  })
  return { response, calls, nexted, body: new Uint8Array(await response.arrayBuffer()) }
}

describe('the ranges the zip reader actually sends', () => {
  it('answers a two-sided range with exactly that slice, and says which one it is', async () => {
    const { response, body, calls } = await answer(ARCHIVE_PATH, { range: 'bytes=100-149' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 100-149/256')
    expect(response.headers.get('content-length')).toBe('50')
    expect(body, 'a 206 carrying the whole object fails a CRC with nothing naming the cause').toEqual(ARCHIVE.subarray(100, 150))
    expect(calls.filter((call) => call.op === 'get')).toEqual([{ op: 'get', key: ARCHIVE_KEY, range: { offset: 100, length: 50 } }])
  })

  it('answers the whole archive when nothing asked for a range', async () => {
    const { response, body } = await answer(ARCHIVE_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range'), 'a whole body is not a partial answer').toBeNull()
    expect(response.headers.get('content-length')).toBe('256')
    expect(body).toEqual(ARCHIVE)
  })

  it('runs an open ended range to the end of the object', async () => {
    const { response, body } = await answer(ARCHIVE_PATH, { range: 'bytes=200-' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 200-255/256')
    expect(body).toEqual(ARCHIVE.subarray(200))
  })

  it('reads a suffix range off the end, which is how a tail would be asked for', async () => {
    const { response, body } = await answer(ARCHIVE_PATH, { range: 'bytes=-16' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 240-255/256')
    expect(body).toEqual(ARCHIVE.subarray(240))
  })

  it('clamps an end past the last byte rather than refusing the read', async () => {
    const { response, body } = await answer(ARCHIVE_PATH, { range: 'bytes=250-999' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 250-255/256')
    expect(response.headers.get('content-length')).toBe('6')
    expect(body).toEqual(ARCHIVE.subarray(250))
  })

  it('refuses a range that starts past the end, and says how long the object is', async () => {
    const { response, calls } = await answer(ARCHIVE_PATH, { range: 'bytes=300-400' })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */256')
    expect(response.headers.get('access-control-allow-origin'), 'a refusal the browser cannot read is a network error').toBe('https://fkn.app')
    expect(calls.some((call) => call.op === 'get'), 'nothing was served, so nothing should have been read').toBe(false)
  })

  it('ignores a Range header it cannot parse, which a static host would have served whole', async () => {
    for (const range of ['bytes=abc-def', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-']) {
      const { response, body } = await answer(ARCHIVE_PATH, { range })
      expect(response.status, `'${range}' is not a range this serves`).toBe(200)
      expect(body).toEqual(ARCHIVE)
    }
  })
})

describe('what each path is served as', () => {
  it('reads the index off its own key, as json a reader may cache for five minutes', async () => {
    const { response, body, calls } = await answer(INDEX_PATH)
    expect(response.status).toBe(200)
    expect(calls).toEqual([{ op: 'get', key: 'ripple/index.json', range: null }])
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control'), 'the index is the one mutable document here').toBe('max-age=300')
    expect(response.headers.get('access-control-allow-origin')).toBe('https://fkn.app')
    expect(response.headers.get('etag')).toBe('"etag-ripple/index.json"')
    expect(new TextDecoder().decode(body)).toBe('{"v":1,"default":"ripple","packages":{}}')
  })

  it('serves an archive as a zip nobody ever needs to re-read, and says ranges are allowed', async () => {
    const { response } = await answer(ARCHIVE_PATH)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('cache-control'), 'the version is in the name, so the bytes never change').toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('access-control-allow-origin')).toBe('https://fkn.app')
    expect(response.headers.get('access-control-expose-headers'), 'a cross origin reader cannot see Content-Range without this').toBe('Content-Range, Accept-Ranges')
    expect(response.headers.get('etag')).toBe(`"etag-${ARCHIVE_KEY}"`)
  })

  it('answers a HEAD with the headers and the size, and no body at all', async () => {
    const { response, body, calls } = await answer(ARCHIVE_PATH, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(body.byteLength, 'a HEAD carrying a body is not a HEAD').toBe(0)
    expect(response.headers.get('content-length')).toBe('256')
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(calls).toEqual([{ op: 'head', key: ARCHIVE_KEY, range: null }])
  })

  it('answers 404 for a key the bucket does not hold, readably', async () => {
    const { response, body, nexted } = await answer('/packages/ripple-9.9.9.zip')
    expect(response.status).toBe(404)
    expect(nexted, 'falling through would answer index.html for a missing archive').toBe(false)
    expect(response.headers.get('access-control-allow-origin'), 'an unreadable 404 arrives as an unreachable host').toBe('https://fkn.app')
    expect(new TextDecoder().decode(body)).toContain('ripple/ripple-9.9.9.zip')
  })

  it('answers the preflight itself, rather than leaving it to the site', async () => {
    for (const path of [INDEX_PATH, ARCHIVE_PATH]) {
      const { response, body, calls, nexted } = await answer(path, { method: 'OPTIONS' })
      expect(response.status, `${path} answered ${response.status} to a preflight`).toBe(204)
      expect(body.byteLength).toBe(0)
      expect(nexted, 'a refused preflight surfaces as an unreachable host, not as a refused request').toBe(false)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://fkn.app')
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD')
      expect(response.headers.get('access-control-allow-headers')).toBe('Range')
      expect(response.headers.get('access-control-max-age')).toBe('86400')
      expect(calls, 'a preflight reads nothing').toEqual([])
    }
  })
})

describe('what it refuses to route', () => {
  it('hands every other path to the site, without touching the bucket', async () => {
    for (const path of ['/', '/watch/1', '/packages', '/packages/', '/index.html', '/.well-known/fkn.json']) {
      const { body, calls, nexted } = await answer(path)
      expect(nexted, `${path} is the site's, not this Function's`).toBe(true)
      expect(new TextDecoder().decode(body)).toBe(NEXT)
      expect(calls).toEqual([])
    }
  })

  it('hands every method but GET, HEAD and OPTIONS to the site', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const { calls, nexted } = await answer(INDEX_PATH, { method })
      expect(nexted, `${method} on the index path is not a read`).toBe(true)
      expect(calls).toEqual([])
    }
  })

  it('never builds a key from a nested path or from a name carrying ..', async () => {
    for (const path of [
      '/packages/nested/ripple-0.0.12.zip',
      '/packages/%2E%2E/index.json',
      '/packages/..%2Findex.json',
      '/packages/ripple..0.0.12.zip',
      '/packages/.hidden.zip',
      '/packages/ripple-0.0.12.zip.txt',
    ]) {
      const { calls, nexted } = await answer(path)
      expect(nexted, `${path} reached the bucket`).toBe(true)
      expect(calls, `${path} reached the bucket`).toEqual([])
    }
  })

  it('says the binding is missing rather than letting index.html stand in for an index', async () => {
    for (const path of [INDEX_PATH, ARCHIVE_PATH]) {
      const { response, body, nexted } = await answer(path, { bind: false })
      expect(response.status, `${path} without the binding`).toBe(503)
      expect(nexted, 'an index.html parsed as an index is an ABSENT index, which boots unsigned').toBe(false)
      expect(new TextDecoder().decode(body), 'the body has to name the binding a dashboard has to set').toContain('PACKAGES')
      expect(response.headers.get('access-control-allow-origin')).toBe('https://fkn.app')
    }
  })
})

/**
 * Which requests are an invocation at all, which is `_routes.json`'s business rather than this
 * file's.
 *
 * A `_middleware` at the functions root runs for EVERY request to the project, and Cloudflare
 * applies `_headers` to a static response and NOT to a Function's. So without a route list the /add
 * frame headers come off the site on the first deploy, silently: `next()` answers the page, the page
 * works, and the header that stops a framing is gone. Nothing this Function can assert about itself
 * sees that, which is why the list and the headers file are read here as text.
 */
describe('which requests reach this Function at all', () => {
  const ROUTES = '../../src/_routes.json'

  const files = import.meta.glob('../../src/_{routes.json,headers}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  /** Pages' own matching: a pattern is an exact path unless it ends in `/*`, which is a prefix. */
  const routed = (pathname: string, patterns: string[]): boolean =>
    patterns.some((pattern) => pattern.endsWith('/*') ? pathname.startsWith(pattern.slice(0, -1)) : pattern === pathname)

  const list = (): { include: string[], exclude: string[] } => {
    const raw = files[ROUTES]
    expect(raw, 'no src/_routes.json, so every request to the project is a Function invocation').toBeTruthy()
    const parsed = JSON.parse(raw!) as { version?: number, include?: string[], exclude?: string[] }
    expect(parsed.version, 'Pages refuses a route list it does not know the version of').toBe(1)
    expect(Array.isArray(parsed.include) && parsed.include.length > 0, 'an empty include list routes nothing here').toBe(true)
    expect(parsed.exclude, 'nothing here needs an exclusion, and one shadowing an include is silent').toEqual([])
    return { include: parsed.include!, exclude: parsed.exclude! }
  }

  it('read both files at all, so a false pass here is not a bad glob', () => {
    expect(list().include.length).toBeGreaterThan(0)
    expect(files['../../src/_headers'], 'the headers file is the thing a route list protects').toBeTruthy()
  })

  it('routes every path this Function answers, or the index and the archives 404 as a site path', async () => {
    const { include } = list()
    for (const path of [INDEX_PATH, ARCHIVE_PATH, '/packages/ripple-9.9.9.zip']) {
      const { nexted } = await answer(path)
      expect(nexted, `${path} is answered here, so it has to be an invocation`).toBe(false)
      expect(routed(path, include), `${path} is answered here and would never be invoked`).toBe(true)
    }
  })

  it('leaves the site out of it, so the /add frame headers keep being applied', async () => {
    const { include } = list()
    const headers = files['../../src/_headers'] ?? ''
    expect(headers, 'the block this is protecting is gone, so the assertion below is vacuous').toContain('X-Frame-Options: DENY')
    for (const path of ['/', '/add', '/index.html', '/assets/index-abc123.js', '/watch/1']) {
      const { nexted } = await answer(path)
      expect(nexted, `${path} is the site's`).toBe(true)
      expect(routed(path, include), `_headers is not applied to a Function response, so ${path} must not be one`).toBe(false)
    }
  })

  it('ships the list with the build, which is the only copy Pages ever reads', () => {
    const copy = (pkg as { scripts?: Record<string, string> }).scripts?.['copy-html']
    expect(copy, 'no copy-html script, so nothing puts the static files in build/').toBeTruthy()
    expect(copy, 'a route list left in src/ is a route list Pages never sees').toContain('src/_routes.json build/_routes.json')
    expect(copy, 'same for the headers file it protects').toContain('src/_headers build/_headers')
  })
})
