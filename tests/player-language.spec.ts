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
const RUSSIAN = ['Воспроизвести', 'Настройки', 'Во весь экран']

const expectLabels = async (scope: Pick<import('@playwright/test').Page, 'getByLabel'>, labels: string[]) => {
  for (const label of labels) await expect(scope.getByLabel(label, { exact: true })).toBeVisible()
}

/** Every catalogue the page fetches from here on, and FormatJS's chunk, which comes with the first of them. */
const catalogues = (page: import('@playwright/test').Page) => {
  const fetched: string[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    const language = /\/([a-z]{2}(?:-[A-Za-z0-9]+)?)-[\w-]{8}-[\w-]{8}\.js$/.exec(pathname)?.[1]
    if (language) fetched.push(language)
    if (/\/intl-[\w-]{8}\.js$/.test(pathname)) fetched.push('intl')
  })
  return fetched
}

test.describe('in an English browser', () => {
  test.use({ locale: 'en-US' })

  test('a link with language=fr shows the player in French', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch('&language=fr'))
    await expectLabels(page, FRENCH)
    expect(fetched.sort()).toEqual(['fr'])
  })

  test('a link with an unknown language shows the player in English, and fetches nothing', async ({ page }) => {
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
    expect(fetched.sort()).toEqual(['fr'])
  })

  for (const tag of ['fr_FR', 'xx', 'sv']) {
    test(`a link with language=${tag}, which the player cannot use, shows it in the browser's`, async ({ page }) => {
      await page.goto(watch(`&language=${tag}`))
      await expectLabels(page, FRENCH)
    })
  }

  // the viewer picked English in the page around the frame: nothing of the browser's French is fetched
  test('a link with language=en shows the player in English', async ({ page }) => {
    const fetched = catalogues(page)
    await page.goto(watch('&language=en'))
    await expectLabels(page, ENGLISH)
    expect(fetched).toEqual([])
  })
})

test.describe('in a browser with no text in its first language', () => {
  const listing = (page: import('@playwright/test').Page, ...languages: string[]) =>
    page.addInitScript((list) => Object.defineProperty(navigator, 'languages', { get: () => list }), languages)

  test('a link with no language shows the next language it lists', async ({ page }) => {
    await listing(page, 'uk', 'ru')
    await page.goto(watch())
    await expectLabels(page, RUSSIAN)
  })

  // stub writes the browser's first language on its link whatever it is
  test('a link naming that language shows the next one too', async ({ page }) => {
    await listing(page, 'sv', 'fr')
    await page.goto(watch('&language=sv'))
    await expectLabels(page, FRENCH)
  })
})

test.describe('in an Arabic browser', () => {
  test.use({ locale: 'ar-EG' })

  // English labels are shown here, so the numbers in them are written as English writes them
  test('the speed menu keeps the digits of its labels', async ({ page }) => {
    await page.goto(watch())
    await page.getByLabel('Settings', { exact: true }).click()
    await page.getByText('Playback speed', { exact: true }).click()
    await expect(page.getByText('0.5x', { exact: true })).toBeVisible()
  })
})
