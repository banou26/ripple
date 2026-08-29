/**
 * The palette.
 *
 * This used to be two constants with a comment explaining that it was deliberately not a theme
 * system, because almost every colour was local to the block that used it. That was true of a design
 * built around a brand gradient, where each block decided how much amber it wanted. It stopped being
 * true when the app went monochrome: once hue is gone, the ONLY thing left to say "this is a button,
 * that is a heading, that other thing is disabled" is how bright it is, and a value invented locally
 * is a hierarchy invented locally. Five files each picking their own grey is five files disagreeing
 * about what emphasis means.
 *
 * So the rule is now the strict one: no colour literal anywhere outside this file. If something on
 * screen needs a colour it comes from here, and if it needs a colour that is not here, the argument
 * about which one it should be happens here, once.
 *
 * ## Contrast
 *
 * Every pairing below was measured rather than chosen by eye (WCAG 2.1 relative luminance, the
 * (L1 + 0.05) / (L2 + 0.05) ratio). Monochrome removes the usual escape hatch: a design with an
 * accent can afford a low-contrast grey because the accent carries the important things, and this
 * one cannot. The numbers in the comments are the measured ratios, not estimates.
 *
 * Thresholds used: 4.5 for normal text, 3.0 for large text and for the boundary of any control that
 * is identified by its outline. Disabled controls are exempt from all of it, which is the only
 * reason a value below 4.5 appears here at all.
 */

/* ---------------------------------------------------------------- surfaces */

/** The page itself. */
export const PAGE_BG = '#0f0f0f'

/** Anything that sits on the page as its own plane: header, footer, cards, rows, dialogs. */
export const SURFACE_BG = '#171717'

/**
 * Surfaces that float above a surface: menus, the detail panel, toasts.
 *
 * It is only 1.05:1 against SURFACE_BG, which is to say invisible on its own. That is deliberate and
 * it is why every floating thing also takes BORDER_STRONG. Stacking two greys this close and hoping
 * the eye reads depth is what the old design used a blur and a 48px drop shadow for; the border is
 * the honest replacement, and it works at any contrast setting.
 */
export const ELEVATED_BG = '#1c1c1c'

/** Resting fill of every button. */
export const CONTROL_BG = '#242424'

/**
 * Hover fill of every button.
 *
 * Must stay LIGHTER than CONTROL_BG. This is the whole hover signal now that there is no accent to
 * borrow, so a block left on an older, darker value lights up backwards.
 */
export const CONTROL_HOVER_BG = '#2e2e2e'

/** Pressed, and the "on" state of a toggle or a selected tab. */
export const CONTROL_ACTIVE_BG = '#383838'

/**
 * Recessed fill: text inputs, progress tracks, the tab strip's groove.
 *
 * Same value as the page on purpose. An input reads as a hole punched in whatever surface it sits
 * on, which is the only way to make it read as recessed when every surface is within 1.2:1 of every
 * other one.
 */
export const SUNKEN_BG = '#0f0f0f'

/* ------------------------------------------------------------------- lines */

/** Hairline separation: card edges, rules between rows, the header's bottom edge. */
export const BORDER = '#272727'

/** Edges that have to carry weight on their own: menus, dialogs, toasts, anything floating. */
export const BORDER_STRONG = '#3a3a3a'

/**
 * The outline of a control that has nothing else to identify it.
 *
 * Text inputs, checkboxes, radio rings, toggle tracks, the drop zone. WCAG 1.4.11 wants 3:1 for a
 * boundary that is the only thing saying a control is there, and none of the greys above come close
 * (BORDER is 1.2:1 on a surface, which is a decoration, not an affordance). Measured 3.4:1 on
 * CONTROL_BG, 3.7:1 on ELEVATED_BG, 3.9:1 on SURFACE_BG, 4.2:1 on PAGE_BG.
 *
 * A button does NOT need this: its text label identifies it, so BORDER is enough there.
 */
export const BORDER_INTERACTIVE = '#757575'

/* -------------------------------------------------------------------- text */

/** Body and headings alike. 17.1:1 on the page, 13.9:1 on a control. */
export const TEXT = '#f2f2f2'

/** Secondary text: stat labels, meta lines, placeholders. AA on every surface, 4.6:1 at worst. */
export const TEXT_MUTED = '#969696'

/**
 * The quietest text that is still text: timestamps, hints, footnotes.
 *
 * AA on PAGE_BG (5.0:1) and SURFACE_BG (4.7:1) only. It drops to 4.0:1 on CONTROL_BG, so it must not
 * be used on a button. Nothing darker than TEXT_MUTED clears AA on a control fill, which is the real
 * constraint: faint text and buttons do not go together in this palette.
 */
export const TEXT_FAINT = '#828282'

/**
 * Disabled controls only.
 *
 * Below AA everywhere, which is allowed precisely because WCAG exempts disabled controls, and is the
 * point: a disabled thing should look unavailable. Never use it for text someone is expected to read.
 */
export const TEXT_DISABLED = '#6b6b6b'

/** For text sitting on a light fill, which in this palette means a primary button. */
export const TEXT_ON_LIGHT = '#0f0f0f'

/* ---------------------------------------------------------------- emphasis */

/**
 * What the accent used to do.
 *
 * A near-white fill: the primary button, the progress bar, a selected row's marker. On CONTROL_BG it
 * measures 12.7:1, so it is by a wide margin the loudest thing available, which is exactly what an
 * accent is for. The old design needed a 10px amber bloom to make a 4px progress bar perceptible;
 * this needs nothing, because the bar is now the brightest object on the page rather than a
 * mid-saturation orange on a purple track.
 */
export const EMPHASIS = '#f2f2f2'

/**
 * Hover on an emphasis fill, and the reason this token exists rather than being improvised per file.
 *
 * A light-filled button has nowhere brighter to go, so four files independently invented four
 * different answers and two of them were wrong. One inverted the polarity on hover (light fill and
 * dark label became dark fill and light label), which makes the loudest control on the page flip
 * appearance under the cursor. The worse one reached for TEXT_MUTED as a fill: that lands on
 * #969696, and a primary button disabled at 45% over a card composites to #7a7a7a, so hovering an
 * ENABLED button made it look like the disabled one sitting next to it.
 *
 * Down, then, not up, and by enough to be unmistakable: 1.4:1 against EMPHASIS, while staying 2.6:1
 * clear of that disabled composite so the two can never be confused. Both are asserted in
 * theme.test.ts, including the composite, because the collision that motivated this token is
 * invisible in any diff that only reads declarations.
 */
export const EMPHASIS_HOVER = '#d0d0d0'

/**
 * Keyboard focus, and it has to be loud.
 *
 * Several controls in this app set `outline: none` and draw their focus ring with a box-shadow
 * instead, so this value is the ONLY thing standing between a keyboard user and an invisible cursor.
 * It is deliberately the same as TEXT: at 13:1 against every control fill it cannot be lost, and the
 * old ring (a 55%-alpha orange) was already the weakest link in the old palette.
 */
export const FOCUS_RING = '#f2f2f2'

/* --------------------------------------------------------------- overlays */

/**
 * The scrim behind a modal.
 *
 * Pure black at 75%, up from the old 62% because the 2px backdrop blur that used to help it is gone.
 * The blur was doing less than it looked: at 2px it mostly killed the hairlines of the list behind
 * the dialog, and alpha does that job on its own.
 */
export const OVERLAY_BG = 'rgba(0, 0, 0, 0.75)'

/**
 * The band behind text laid over video.
 *
 * The one place a wash is not decoration. Video is arbitrary content, so no fixed text colour is
 * safe on it, and the embed overlay has no other protection: this plus the per-glyph text shadow is
 * the whole system. It stays translucent so the picture still reads underneath.
 */
export const VIDEO_SCRIM = 'rgba(0, 0, 0, 0.45)'

/**
 * The per-glyph half of the same problem, and the only blur left in the app.
 *
 * The redesign deletes every blur as decoration, and this one is not decoration: a scrim protects a
 * BAND, and a glyph sitting over a bright frame inside that band still needs its own edge. It is
 * kept for the same reason the scrim is, and it is a token rather than a literal so that the rule
 * "no colour outside this file" survives with no exceptions, which is what lets the checker treat
 * any literal it finds as a defect rather than a judgement call.
 */
export const VIDEO_TEXT_SHADOW = 'rgba(0, 0, 0, 1)'

/* ----------------------------------------------------------------- status */

/**
 * Colours that survive a monochrome design because they are not decoration.
 *
 * The test each one had to pass: does deleting it destroy information that nothing else on screen
 * carries. A "DOWNLOADING" badge fails that test, because the badge says "DOWNLOADING" in words and
 * the amber was telling you nothing the label was not. A storage-almost-full warning passes it: it
 * is a caution in a strip of otherwise neutral facts, and greying it makes it just another fact.
 */

/** Success, and the premium account tier. 7.6:1 at worst. */
export const OK = '#7dd3a0'

/**
 * Caution: storage low, quota throttled, sync failing.
 *
 * This is the retired brand amber and reusing it needs justifying. What makes it defensible is that
 * nothing else on the page is warm any more, so it no longer reads as branding, it reads as the one
 * thing asking for attention. It is restricted to text and borders on a warning callout, and it is
 * never a fill and never near the wordmark.
 */
export const WARN = '#fbbf24'

/**
 * Errors, in text.
 *
 * Lighter than the old #ef4444, which measured 4.1:1 on a control fill and 3.6:1 on a hovered one,
 * putting it under AA exactly where a destructive button lives. This one is 4.9:1 at its worst.
 */
export const DANGER = '#f87171'

/** Errors, as a fill. Pair with TEXT, never with DANGER. */
export const DANGER_SOLID = '#ef4444'

/* ------------------------------------------------------------------ charts */

/**
 * Two series, told apart by brightness.
 *
 * 4.8:1 between them, and the quieter one still holds 3.4:1 against the card it is drawn on, so it
 * is a line rather than a smudge. Download is the bright one because it is the series a torrent
 * client is usually about; upload rides over it as a plain line.
 *
 * Two is the number this palette can carry honestly. A third monochrome series would have to sit
 * between these, and "slightly dimmer than the dim one" is not a distinction anyone can read off a
 * 26 pixel sparkline. If a third is ever needed it wants a shape, a dash pattern or a label, not
 * another grey.
 */
export const CHART_PRIMARY = '#f2f2f2'
export const CHART_PRIMARY_FILL = 'rgba(242, 242, 242, 0.16)'
export const CHART_SECONDARY = '#6b6b6b'

/** Faint hover washes, where a fill has to register without becoming a surface of its own. */
export const HOVER_WASH = 'rgba(255, 255, 255, 0.07)'
