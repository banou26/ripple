import type { CompactDesign } from '../components/compact-toolbar'

/**
 * Prototype only (RIPPLE-130): which list toolbar the library draws, from `?toolbar=a|b|c` on the address the app was
 * opened at. Read once, so a choice holds across the app's own navigation, and dropped with the designs not picked.
 */
const asked = new URLSearchParams(globalThis.location?.search ?? '')

export const TOOLBAR: CompactDesign | 'layout2' = (['a', 'b', 'c'] as const).find((design) => design === asked.get('toolbar')) ?? 'layout2'
