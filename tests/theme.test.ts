import { describe, expect, it } from 'vitest'

import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CHART_PRIMARY, CHART_SECONDARY, CONTROL_ACTIVE_BG,
  CONTROL_BG, CONTROL_HOVER_BG, DANGER, DANGER_SOLID, ELEVATED_BG, EMPHASIS, EMPHASIS_HOVER,
  FOCUS_RING, OK,
  PAGE_BG, SUNKEN_BG, SURFACE_BG, TEXT, TEXT_DISABLED, TEXT_FAINT, TEXT_MUTED, TEXT_ON_LIGHT, WARN
} from '../src/theme'

/**
 * The palette's contrast, asserted rather than asserted-in-a-comment.
 *
 * A monochrome design has exactly one mechanism for hierarchy, so a value nudged two steps darker
 * because it looked nicer is not a taste change, it is a legibility change, and it is invisible in
 * review: the diff says `#969696` became `#8a8a8a` and nothing says a stat label just fell under AA.
 * These are the numbers the theme's comments claim. If an edit breaks one, the comment became a lie
 * and this fails instead of nobody noticing.
 *
 * WCAG 2.1: ratio is (L1 + 0.05) / (L2 + 0.05) over relative luminance.
 *   4.5  normal text            3.0  large text, and the boundary of an outline-identified control
 * Disabled controls are exempt, which is why TEXT_DISABLED is asserted to be BELOW the threshold:
 * looking unavailable is its job.
 */

const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/**
 * A colour's three channels, 0 to 255, as a tuple rather than an array.
 *
 * The tuple is the point: destructuring an array gives three `number | undefined` under
 * `noUncheckedIndexedAccess`, so every arithmetic use of them is a type error, and the shape that
 * silences it is a default value, which would turn a malformed colour into a plausible black. It
 * throws instead, since a theme constant that is not a colour is a bug rather than a shade.
 */
const channels = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`)
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  return [r!, g!, b!]
}

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex)
  return 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255)
}

const contrast = (a: string, b: string) => {
  const one = luminance(a)
  const two = luminance(b)
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

/** Every background at all. Only things that must work anywhere are held to this one. */
const SURFACES = { PAGE_BG, SURFACE_BG, ELEVATED_BG, CONTROL_BG, CONTROL_HOVER_BG, CONTROL_ACTIVE_BG }

/**
 * The backgrounds that quiet text can actually land on.
 *
 * CONTROL_ACTIVE_BG is excluded, and that exclusion is a design rule rather than a convenience: a
 * pressed or selected control states its selection by going bright, so its label is TEXT. Nothing
 * muted, faint or status-coloured is ever drawn on it. The rule is asserted below rather than left
 * implicit, because the tempting alternative was to lighten every quiet colour until it cleared a
 * surface nothing quiet is drawn on, which would have flattened the hierarchy to satisfy a case
 * that does not occur.
 */
const TEXT_SURFACES = { PAGE_BG, SURFACE_BG, ELEVATED_BG, CONTROL_BG, CONTROL_HOVER_BG }

const worstOn = (fg: string, backgrounds: Record<string, string> = TEXT_SURFACES) =>
  Math.min(...Object.values(backgrounds).map(bg => contrast(fg, bg)))

/** How far a colour is from being a grey. Zero means it is one. */
const chroma = (hex: string) => {
  const h = hex.replace('#', '')
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return Math.max(...v) - Math.min(...v)
}

describe('the palette carries its own hierarchy', () => {
  it('puts body text far above AA on every surface there is, pressed controls included', () => {
    expect(worstOn(TEXT, SURFACES)).toBeGreaterThanOrEqual(7)
  })

  it('keeps secondary text at AA everywhere it is allowed, including on a hovered button', () => {
    // #8f8f8f, the value this started as, measures 4.20 on CONTROL_HOVER_BG and fails here.
    expect(worstOn(TEXT_MUTED)).toBeGreaterThanOrEqual(4.5)
  })

  /** The exclusion above, stated as an obligation rather than left as a gap in the coverage. */
  it('requires a pressed control to label itself in full-brightness text', () => {
    expect(contrast(TEXT, CONTROL_ACTIVE_BG)).toBeGreaterThanOrEqual(7)
    expect(contrast(TEXT_MUTED, CONTROL_ACTIVE_BG)).toBeLessThan(4.5)
  })

  /**
   * The one token with a placement restriction, so the restriction is what gets asserted: AA where
   * it is allowed, and explicitly NOT good enough on a control, which is the documented reason it
   * may not be used on one.
   */
  it('keeps the faintest real text at AA on the two surfaces it is allowed on', () => {
    expect(contrast(TEXT_FAINT, PAGE_BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(TEXT_FAINT, SURFACE_BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('cannot rescue faint text on a button, which is why the theme forbids it', () => {
    expect(contrast(TEXT_FAINT, CONTROL_BG)).toBeLessThan(4.5)
  })

  it('leaves disabled text visibly unavailable, below AA on purpose', () => {
    expect(worstOn(TEXT_DISABLED)).toBeLessThan(4.5)
  })

  it('orders the surfaces from the page upward, with no two swapped', () => {
    const ladder = [PAGE_BG, SURFACE_BG, ELEVATED_BG, CONTROL_BG, CONTROL_HOVER_BG, CONTROL_ACTIVE_BG]
    const lum = ladder.map(luminance)
    expect(lum).toEqual([...lum].sort((a, b) => a - b))
  })

  it('keeps a recessed fill no lighter than the page, so an input reads as a hole', () => {
    expect(luminance(SUNKEN_BG)).toBeLessThanOrEqual(luminance(PAGE_BG))
  })
})

describe('controls stay identifiable', () => {
  /**
   * The rule this encodes: a button is identified by its label, so a hairline is enough. A text
   * input, a checkbox and a radio ring have nothing but their outline, so the outline has to clear
   * 3:1 by itself.
   */
  it('gives outline-identified controls a boundary that clears 3:1 where they sit', () => {
    for (const bg of [PAGE_BG, SURFACE_BG, ELEVATED_BG, CONTROL_BG]) {
      expect(contrast(BORDER_INTERACTIVE, bg)).toBeGreaterThanOrEqual(3)
    }
  })

  it('does not pretend the hairline is an affordance', () => {
    // BORDER is decoration. Asserting it is BELOW 3:1 stops someone "fixing" an input by reaching
    // for it, which would look like a fix and change nothing a screen reader or a low-contrast
    // display would notice.
    expect(contrast(BORDER, SURFACE_BG)).toBeLessThan(3)
    expect(contrast(BORDER_STRONG, SURFACE_BG)).toBeLessThan(3)
  })

  /**
   * Focus is the one that hurts if it regresses, because several controls in this app set
   * `outline: none` and draw the ring with a box-shadow, so there is no browser default underneath
   * to fall back on.
   */
  it('makes the focus ring the loudest thing against any control it lands on', () => {
    expect(worstOn(FOCUS_RING)).toBeGreaterThanOrEqual(7)
  })

  it('keeps a primary button legible, light fill and dark label', () => {
    expect(contrast(EMPHASIS, TEXT_ON_LIGHT)).toBeGreaterThanOrEqual(7)
  })

  it('makes the emphasis fill unmistakable against the track behind it', () => {
    expect(contrast(EMPHASIS, CONTROL_BG)).toBeGreaterThanOrEqual(7)
  })

  /**
   * A light button has nowhere brighter to go on hover, so it goes down. The two numbers below are
   * the two ways that went wrong when four files each invented their own answer: a step too small to
   * see, and a step so large it landed on the disabled appearance.
   */
  describe('hovering a primary button', () => {
    /** EMPHASIS at the shared 45% disabled opacity, composited over the card it sits on. */
    const disabledComposite = (() => {
      const mix = (fg: number, bg: number) => Math.round(0.45 * fg + 0.55 * bg)
      const [fr, fg, fb] = channels(EMPHASIS)
      const [br, bg, bb] = channels(SURFACE_BG)
      return '#' + [mix(fr, br), mix(fg, bg), mix(fb, bb)]
        .map(c => c.toString(16).padStart(2, '0'))
        .join('')
    })()

    it('moves down rather than up, because there is no up', () => {
      expect(luminance(EMPHASIS_HOVER)).toBeLessThan(luminance(EMPHASIS))
    })

    it('moves far enough to be seen', () => {
      expect(contrast(EMPHASIS, EMPHASIS_HOVER)).toBeGreaterThanOrEqual(1.3)
    })

    it('does not land on the disabled appearance, which is the trap it was built for', () => {
      expect(contrast(EMPHASIS_HOVER, disabledComposite)).toBeGreaterThanOrEqual(2)
      expect(luminance(EMPHASIS_HOVER)).toBeGreaterThan(luminance(disabledComposite))
    })

    it('still carries a dark label at AAA once dimmed', () => {
      expect(contrast(EMPHASIS_HOVER, TEXT_ON_LIGHT)).toBeGreaterThanOrEqual(7)
    })
  })
})

describe('the colours that survived because they mean something', () => {
  it('keeps success at AA everywhere', () => {
    expect(worstOn(OK)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps a caution at AA everywhere', () => {
    expect(worstOn(WARN)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps error TEXT at AA everywhere, which the old red did not manage', () => {
    // #ef4444 measures 4.13 on CONTROL_BG and 3.61 on CONTROL_HOVER_BG: under AA exactly where a
    // destructive button lives, which is the worst possible place to be under it.
    expect(worstOn(DANGER)).toBeGreaterThanOrEqual(4.5)
  })

  it('pairs the error FILL with body text rather than with the error text colour', () => {
    expect(contrast(DANGER_SOLID, TEXT)).toBeGreaterThanOrEqual(3)
    // the trap: red text on a red fill, which is what happens if the two danger tokens get mixed up
    expect(contrast(DANGER_SOLID, DANGER)).toBeLessThan(3)
  })

  /**
   * The property that actually matters for a status colour here, and NOT the one a contrast ratio
   * can express. OK and WARN sit at almost identical luminance, so they measure 1.08:1 against each
   * other while being obviously different colours: contrast is a brightness metric and hue is
   * invisible to it. What makes a status readable in this palette is that it carries hue at all,
   * because nothing else on the page does. A status colour that drifted grey would vanish into the
   * hierarchy while every contrast assertion above kept passing.
   */
  it('keeps every status colour visibly coloured, in a palette where nothing else is', () => {
    for (const status of [OK, WARN, DANGER, DANGER_SOLID]) {
      expect(chroma(status)).toBeGreaterThanOrEqual(60)
    }
  })

  it('keeps every structural colour a true grey, so hue only ever means status', () => {
    const structural = [
      PAGE_BG, SURFACE_BG, ELEVATED_BG, CONTROL_BG, CONTROL_HOVER_BG, CONTROL_ACTIVE_BG, SUNKEN_BG,
      BORDER, BORDER_STRONG, BORDER_INTERACTIVE,
      TEXT, TEXT_MUTED, TEXT_FAINT, TEXT_DISABLED, TEXT_ON_LIGHT,
      EMPHASIS, FOCUS_RING, CHART_PRIMARY, CHART_SECONDARY
    ]
    for (const grey of structural) expect(chroma(grey)).toBe(0)
  })
})

describe('a monochrome chart still has two readable series', () => {
  it('separates the two series by more than the 3:1 a graphical object needs', () => {
    expect(contrast(CHART_PRIMARY, CHART_SECONDARY)).toBeGreaterThanOrEqual(3)
  })

  it('keeps the quieter series visible against the card it is drawn on', () => {
    expect(contrast(CHART_SECONDARY, SURFACE_BG)).toBeGreaterThanOrEqual(3)
  })
})
