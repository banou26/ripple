/**
 * The few colours that have to agree across pages.
 *
 * Not a theme system, and deliberately not one: almost every colour in this app is local to the
 * block that uses it and is better read there than looked up here. These two are the exception
 * because a control on the header, a control on a row and a control in the embed builder are all the
 * same object to the person clicking them, and three files disagreeing about that is exactly what
 * this is here to stop.
 *
 * Buttons used to be `background: none` over a one pixel border, which on a page this dark left them
 * reading as text in a faint box rather than as something pressable. `CONTROL_BG` is a shade lighter
 * than the cards controls sit on, so a button is visible before the pointer reaches it.
 *
 * `CONTROL_HOVER_BG` must stay LIGHTER than `CONTROL_BG`. The hover colour these replaced was
 * #241e30, which is darker than the new fill, so any block left on the old value lights up backwards
 * on hover.
 */
export const CONTROL_BG = '#2a2436'
export const CONTROL_HOVER_BG = '#352e45'
