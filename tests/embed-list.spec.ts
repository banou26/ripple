// The site's embed list, on the built bytes: fkn.app reads /.well-known/fkn.json to learn which apps may frame
// Ripple's pages, and a missing file reads as "nobody". The rig serves with `serve -s`, which answers a missing path
// with index.html and a 200, as Cloudflare Pages did for this path before the file existed, so the check is that
// the answer is the file itself.
import { expect, test } from './offline'

test('the site answers its embed list as JSON, naming every app', async ({ request }) => {
  const answer = await request.get('/.well-known/fkn.json')
  expect(answer.status()).toBe(200)
  expect(answer.headers()['content-type']).toMatch(/^application\/json/)
  expect(await answer.json()).toEqual({ v: 1, embed: ['*'] })
})

// the control: a path the build does not carry comes back as the page, so the test above can tell the two apart
test('a path the build does not carry answers the page, not a file', async ({ request }) => {
  const answer = await request.get('/.well-known/not-there.json')
  expect(answer.headers()['content-type']).toMatch(/^text\/html/)
})
