// Does ripple survive the broker reserving a strip at the top of the viewport?
//
// @fkn/lib 0.9.22 added a "docked" broker header. When the user picks that mode the lib writes two
// properties on the ROOT element (see @fkn/lib src/lib/overlay.ts, applyInset):
//
//   document.documentElement.style.setProperty('margin-top', `${top}px`, 'important')
//   document.documentElement.style.setProperty('--fkn-inset-top', `${top}px`)
//
// The lib's own comment says what that costs: "A page laid out to exactly fill the viewport (100vh,
// html/body height 100%) grows by the strip and scrolls by it". Ripple is exactly that page, so the
// variable is the app's half of the contract and this script is the check that ripple holds it up.
//
// Neither property exists in 0.9.19, so this measures something the bump introduced.
//
// The rig applies those two properties verbatim rather than driving the real broker header, because
// the header lives in a cross-origin frame on fkn.app and reaching Docked mode there needs an
// account. Copying the two lines the lib runs keeps the mechanism identical and the rig hermetic.
//
// Headless is right here: this reads geometry, it observes no transfer and needs no compositor.
// Muted regardless, on the house rule that every launch is muted.

import { chromium } from 'playwright'
import { spawn } from 'child_process'

const PORT = 4599
const ORIGIN = `http://127.0.0.1:${PORT}`
const INSET = 40 // BAR_HEIGHT in the broker's header

// detached so the whole process group can be signalled: `npx` forks the real server, and killing
// only the wrapper leaves an orphan holding the port, which the next run then reads instead of the
// build it just made. That is a rig quietly measuring stale bytes, so it is worth the extra flag.
const serve = () => {
  const proc = spawn('npx', ['serve', '-s', '-C', '-p', String(PORT), 'build'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  // kept so a server that refuses to start says why, instead of the rig reporting a bare timeout
  proc.log = []
  proc.stdout.on('data', (b) => proc.log.push(String(b)))
  proc.stderr.on('data', (b) => proc.log.push(String(b)))
  return proc
}

const stopServer = (proc) => {
  try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill() } catch {} }
}

const waitForServer = async (proc) => {
  let last
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(ORIGIN)
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (err) { last = String(err?.cause?.code ?? err?.message ?? err) }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server never came up on ${ORIGIN} (last: ${last})\n${proc.log.join('')}`)
}

/** Exactly what @fkn/lib's applyInset does, and exactly what it does to undo it. */
const applyInset = (top) => {
  const style = document.documentElement.style
  if (top > 0) {
    style.setProperty('margin-top', `${top}px`, 'important')
    style.setProperty('--fkn-inset-top', `${top}px`)
  } else {
    style.removeProperty('margin-top')
    style.removeProperty('--fkn-inset-top')
  }
}

const measure = () => {
  const doc = document.scrollingElement ?? document.documentElement
  const root = document.querySelector('body > .mount > *')
  const footer = document.querySelector('footer')
  return {
    variable: getComputedStyle(document.documentElement).getPropertyValue('--fkn-inset-top').trim(),
    rootMarginTop: document.documentElement.style.marginTop,
    innerHeight: window.innerHeight,
    scrollHeight: doc.scrollHeight,
    // the number that matters: how far the document overflows the viewport it was meant to fill
    overflow: doc.scrollHeight - window.innerHeight,
    appTop: root ? Math.round(root.getBoundingClientRect().top) : null,
    appHeight: root ? Math.round(root.getBoundingClientRect().height) : null,
    footerBottom: footer ? Math.round(footer.getBoundingClientRect().bottom) : null,
    footerFullyVisible: footer ? footer.getBoundingClientRect().bottom <= window.innerHeight : null,
  }
}

// Every route that lays itself out against the viewport, so a strip reserved on the root reaches it.
// /add and /embed are omitted deliberately: both need a magnet to render anything.
//
// Each route gets a viewport TALLER THAN ITS OWN CONTENT on purpose. The rule under test is the
// viewport-height one (`height: 100dvh`, `min-height: 100vh`), and that rule only binds while the
// content is shorter than the viewport. Measured at 800px the legal pages already scroll on their
// own text, the strip is then a correct 40px of extra scroll rather than a defect, and the check
// would be reading the prose instead of the layout.
const ROUTES = [
  { path: '/', ready: 'footer', viewport: { width: 1280, height: 800 } },
  { path: '/legal', ready: '.shell', viewport: { width: 1280, height: 1200 } },
  { path: '/privacy', ready: '.shell', viewport: { width: 1280, height: 1400 } },
]

const checkRoute = async (page, route) => {
  await page.setViewportSize(route.viewport)
  // not networkidle: ripple keeps the broker frame and its polls open, so the network never idles
  await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(route.ready, { timeout: 30_000 })

  // Hover mode: the lib reserves nothing. This is the control, and it must be clean, because a rig
  // that reports overflow with no strip reserved is measuring ripple's own layout, not the inset.
  const hover = await page.evaluate(measure)

  await page.evaluate(applyInset, INSET)
  await page.waitForTimeout(150)
  const docked = await page.evaluate(measure)

  // and back, to prove the effect is the strip and nothing else drifting during the run
  await page.evaluate(applyInset, 0)
  await page.waitForTimeout(150)
  const restored = await page.evaluate(measure)

  const line = (name, m) =>
    `  ${name.padEnd(9)} var=${(m.variable || '(unset)').padEnd(7)} margin=${(m.rootMarginTop || '(unset)').padEnd(7)}` +
    ` overflow=${String(m.overflow).padStart(4)}px appTop=${String(m.appTop).padStart(3)} appH=${String(m.appHeight).padStart(4)}` +
    ` footerBottom=${String(m.footerBottom).padStart(5)} footerVisible=${m.footerFullyVisible}`

  console.log(route.path)
  console.log(line('HOVER', hover))
  console.log(line('DOCKED', docked))
  console.log(line('RESTORED', restored))

  const broken = []
  // the control has to be clean or nothing below means anything
  if (hover.overflow !== 0) broken.push(`CONTROL BROKEN: page already overflows by ${hover.overflow}px with no strip reserved`)
  if (hover.variable !== '') broken.push(`CONTROL BROKEN: --fkn-inset-top is set before anything reserved a strip`)
  // the rig has to be able to express the failure, or a pass proves nothing
  if (docked.variable !== `${INSET}px`) broken.push(`RIG BROKEN: the lib's variable did not land (got "${docked.variable}")`)
  if (docked.rootMarginTop !== `${INSET}px`) broken.push(`RIG BROKEN: the lib's root margin did not land (got "${docked.rootMarginTop}")`)
  if (restored.overflow !== hover.overflow) broken.push(`RIG BROKEN: removing the strip did not restore the page`)
  if (broken.length) {
    for (const b of broken) console.log(`  ${b}`)
    return 'broken'
  }

  const fits = docked.overflow === 0 && (docked.footerFullyVisible ?? true)
  console.log(`  ${fits ? 'PASS' : 'FAIL'}: a ${INSET}px reserved strip ${fits ? 'leaves the page fitting the viewport' : `makes the page overflow by ${docked.overflow}px`}`)
  console.log('')
  return fits ? 'pass' : 'fail'
}

const run = async () => {
  const server = serve()
  let code = 0
  try {
    await waitForServer(server)
    const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
    const page = await browser.newPage()
    const results = []
    for (const route of ROUTES) results.push(await checkRoute(page, route))
    await browser.close()

    if (results.includes('broken')) { console.log('RIG OR CONTROL BROKEN, no verdict'); code = 2 }
    else if (results.includes('fail')) { console.log(`${results.filter((r) => r === 'fail').length} of ${results.length} routes overflow when the broker docks its header`); code = 1 }
    else console.log(`all ${results.length} routes fit the viewport with a ${INSET}px strip reserved`)
  } finally {
    // never process.exit() before this: it skips the cleanup and leaks the server
    stopServer(server)
  }
  return code
}

run().then((code) => process.exit(code), (err) => { console.error(err); process.exit(3) })
