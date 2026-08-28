// The header, across the widths where it used to fall apart.
//
// Three unshrinkable controls in one row (the input, Add, Open file) took every pixel out of the
// only flexible item: the field measured 52px at a 900px viewport and 34px at 800px, where the form
// overflowed and the document grew a horizontal scrollbar. The fix was not a wider field, it was
// putting the two buttons inside the field as icons so nothing competes with it for the row.
//
// So this asserts the thing that actually broke: the field keeps a width worth reading, and the
// document never scrolls sideways. A screenshot at each width is written for looking at.
//
// Headless: geometry and a picture, no transfer observed. Muted on the house rule.

import { chromium } from 'playwright'
import { spawn } from 'child_process'

const PORT = 4603
const ORIGIN = `http://127.0.0.1:${PORT}`
const OUT = process.env.SHOT_DIR ?? '/tmp/claude-1000/-home-banou-dev-ripple'

// below this the placeholder stops being readable, which is the page's whole explanation of how to
// add anything. 210px was the old floor the input carried explicitly; the pill has to beat it.
const READABLE_PX = 210

const WIDTHS = [1440, 1100, 900, 800, 700, 620, 520, 420]

const serve = () => spawn('npx', ['serve', '-s', '-C', '-p', String(PORT), 'build'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const stop = (p) => { try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill() } catch {} } }

const waitUp = async () => {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(ORIGIN)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server never came up')
}

const measure = () => {
  const field = document.querySelector('header .field')
  const input = field?.querySelector("input:not([type='file'])")
  const icons = [...(field?.querySelectorAll('.icon') ?? [])]
  const doc = document.documentElement
  return {
    fieldWidth: field ? Math.round(field.getBoundingClientRect().width) : 0,
    inputWidth: input ? Math.round(input.getBoundingClientRect().width) : 0,
    icons: icons.length,
    // every icon has to be reachable, so none may be clipped out of the pill
    iconsInsideField: field
      ? icons.every((i) => {
          const a = i.getBoundingClientRect(); const b = field.getBoundingClientRect()
          return a.left >= b.left - 1 && a.right <= b.right + 1
        })
      : false,
    docOverflowX: doc.scrollWidth - doc.clientWidth,
    // the two that were removed; their absence is the ask
    hasAddButton: [...document.querySelectorAll('header button')].some((b) => b.textContent?.trim() === 'Add'),
    hasOpenFileButton: [...document.querySelectorAll('header *')].some((e) => e.textContent?.trim() === 'Open file'),
    shareLabel: [...document.querySelectorAll('header button')].map((b) => b.textContent?.trim()).find((t) => t?.includes('Share')) ?? null,
  }
}

const server = serve()
let code = 0
try {
  await waitUp()
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
  const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('header .field', { timeout: 30_000 })

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForTimeout(150)
    const m = await page.evaluate(measure)
    if (width === 1440 || width === 800 || width === 420) {
      await page.screenshot({ path: `${OUT}/header-${width}.png`, clip: { x: 0, y: 0, width, height: 120 } })
    }
    const bad = []
    if (m.docOverflowX !== 0) bad.push(`document scrolls sideways by ${m.docOverflowX}px`)
    if (m.inputWidth < READABLE_PX) bad.push(`the text is only ${m.inputWidth}px, under the ${READABLE_PX}px floor`)
    if (m.icons !== 2 && m.icons !== 3) bad.push(`expected 2 or 3 icons, saw ${m.icons}`)
    if (!m.iconsInsideField) bad.push('an icon is clipped out of the pill')
    if (m.hasAddButton) bad.push('the Add button is still there')
    if (m.hasOpenFileButton) bad.push('the Open file button is still there')
    console.log(`${String(width).padStart(4)}px  field=${String(m.fieldWidth).padStart(4)} text=${String(m.inputWidth).padStart(4)} icons=${m.icons} overflowX=${m.docOverflowX} share=${JSON.stringify(m.shareLabel)}  ${bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS'}`)
    if (bad.length) code = 1
  }

  // Typing changes the control: a clear button appears and the submit stops being dead. Both were
  // words before and are now shapes, so whether they show up at the right moment is the whole of
  // whether this reads as a control at all.
  await page.setViewportSize({ width: 1440, height: 800 })
  // the FKN bar shows a 3s intro on arrival and then folds; waiting it out is only so the picture
  // below is of ripple's header rather than of the platform chrome sitting over it
  await page.waitForTimeout(4_000)
  await page.fill("header .field input:not([type='file'])", 'magnet:?xt=urn:btih:0000')
  await page.waitForTimeout(150)
  const typed = await page.evaluate(() => {
    const field = document.querySelector('header .field')
    const icons = [...(field?.querySelectorAll('.icon') ?? [])]
    const submit = field?.querySelector('button[type="submit"]')
    return {
      icons: icons.length,
      labels: icons.map((i) => i.getAttribute('aria-label')),
      submitEnabled: submit ? !submit.disabled : false,
    }
  })
  await page.screenshot({ path: `${OUT}/header-typed.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } })

  const bad = []
  if (typed.icons !== 3) bad.push(`expected 3 icons once typing, saw ${typed.icons}`)
  if (!typed.labels.includes('Clear')) bad.push(`no Clear button: ${JSON.stringify(typed.labels)}`)
  if (!typed.submitEnabled) bad.push('the submit is still disabled with a magnet in the field')
  console.log(`typed        icons=${typed.icons} ${JSON.stringify(typed.labels)} submitEnabled=${typed.submitEnabled}  ${bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS'}`)
  if (bad.length) code = 1

  // and clearing puts it back, including the focus, so the next paste goes where they are looking
  await page.click('header .field button[aria-label="Clear"]')
  await page.waitForTimeout(150)
  const cleared = await page.evaluate(() => {
    const input = document.querySelector("header .field input:not([type='file'])")
    return {
      value: input?.value ?? null,
      icons: document.querySelectorAll('header .field .icon').length,
      focused: document.activeElement === input,
    }
  })
  const badClear = []
  if (cleared.value !== '') badClear.push(`field still holds ${JSON.stringify(cleared.value)}`)
  if (cleared.icons !== 2) badClear.push(`clear button did not go away, ${cleared.icons} icons`)
  if (!cleared.focused) badClear.push('focus was not returned to the field')
  console.log(`cleared      value=${JSON.stringify(cleared.value)} icons=${cleared.icons} focused=${cleared.focused}  ${badClear.length ? 'FAIL: ' + badClear.join('; ') : 'PASS'}`)
  if (badClear.length) code = 1

  if (errors.length) { console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`); code = 1 }
  await browser.close()
} finally {
  stop(server)
}
process.exit(code)
