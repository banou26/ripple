// The player on built bytes in the language a link or the browser names: the labels read here come from its real
// catalogues, so one the build dropped, or a language lost on the way to the player, shows. Nothing needs bytes to
// arrive, so it runs headless, on torrents nobody seeds.
import { expect, test } from '@playwright/test'

const magnetOf = (hash: string) => `magnet:?xt=urn:btih:${hash.repeat(40)}&dn=Nothing`
const FIRST = magnetOf('a')
const NEXT = magnetOf('b')
const watch = (search = '') => `/watch?${new URLSearchParams({ magnet: Buffer.from(FIRST).toString('base64') })}${search}`

const FRENCH = ['Lecture', 'Paramètres', 'Plein écran']
const ENGLISH = ['Play', 'Settings', 'Full screen']

const expectLabels = async (scope: Pick<import('@playwright/test').Page, 'getByLabel'>, labels: string[]) => {
  for (const label of labels) await expect(scope.getByLabel(label, { exact: true })).toBeVisible()
}

/** Every catalogue the page fetches, from here on. */
const catalogues = (page: import('@playwright/test').Page) => {
  const fetched: string[] = []
  page.on('request', (request) => {
    const language = /\/([a-z]{2}(?:-[A-Za-z0-9]+)?)-[\w-]{8}-[\w-]{8}\.js$/.exec(new URL(request.url()).pathname)?.[1]
    if (language) fetched.push(language)
  })
  return fetched
}

test.describe('in an English browser', () => {
  test.use({ locale: 'en-US' })

  test('a link with language=fr shows the player in French', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch('&language=fr'))
    await expectLabels(page, FRENCH)
    expect(fetched).toEqual(['fr'])
  })

  test('a link with an unknown language shows the player in the browser\'s, and fetches nothing', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch('&language=xx'))
    await expectLabels(page, ENGLISH)
    expect(fetched).toEqual([])
  })

  test('the next file opened in place stays in the link\'s language', async ({ page }) => {
    await page.goto('/legal')
    await page.evaluate((src) => { document.body.append(Object.assign(document.createElement('iframe'), { id: 'ripple', src })) }, watch('&language=fr'))
    const ripple = page.frameLocator('#ripple')
    await expectLabels(ripple, FRENCH)

    const opened = page.evaluate(() => new Promise(resolve => { addEventListener('message', event => { if (event.data?.ripple === 'opened') resolve(true) }) }))
    await page.evaluate((magnet) => (document.getElementById('ripple') as HTMLIFrameElement).contentWindow!.postMessage({ ripple: 'open', magnet, fileIndex: 2 }, '*'), NEXT)
    await opened
    const frame = () => page.frames().find(f => f.url().includes('/watch?'))!
    await expect.poll(() => new URL(frame().url()).searchParams.get('fileIndex')).toBe('2')
    expect(new URL(frame().url()).searchParams.get('language')).toBe('fr')
    await expectLabels(ripple, FRENCH)
  })
})

test.describe('in a French browser', () => {
  test.use({ locale: 'fr-FR' })

  test('a link with no language shows the player in French', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch())
    await expectLabels(page, FRENCH)
    expect(fetched).toEqual(['fr'])
  })

  test('a malformed language shows the player in the browser\'s', async ({ page }) => {
    await page.goto(watch('&language=fr_FR'))
    await expectLabels(page, FRENCH)
  })

  // the viewer picked English in the page around the frame: nothing of the browser's French is fetched
  test('a link with language=en shows the player in English', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch('&language=en'))
    await expectLabels(page, ENGLISH)
    expect(fetched).toEqual([])
  })
})
