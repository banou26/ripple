import type { Tweaks } from './types'

import { useState, useCallback } from 'react'

const STORAGE_KEY = 'ripple.tweaks'

export const ACCENTS = {
  water: { light: 'oklch(0.62 0.135 230)', soft: 'oklch(0.92 0.04 230)', text: 'oklch(0.42 0.13 230)', dark: 'oklch(0.74 0.135 230)', darkSoft: 'oklch(0.32 0.06 230)' },
  ember: { light: 'oklch(0.62 0.15 35)', soft: 'oklch(0.94 0.04 35)', text: 'oklch(0.45 0.15 35)', dark: 'oklch(0.74 0.15 35)', darkSoft: 'oklch(0.32 0.07 35)' },
  moss: { light: 'oklch(0.58 0.12 150)', soft: 'oklch(0.94 0.04 150)', text: 'oklch(0.4 0.12 150)', dark: 'oklch(0.72 0.13 150)', darkSoft: 'oklch(0.3 0.06 150)' },
  violet: { light: 'oklch(0.6 0.16 290)', soft: 'oklch(0.93 0.04 290)', text: 'oklch(0.42 0.16 290)', dark: 'oklch(0.74 0.14 290)', darkSoft: 'oklch(0.3 0.07 290)' },
}

export const applyTweaks = (tweak: Tweaks) => {
  const root = document.documentElement
  root.setAttribute('data-theme', tweak.theme)
  root.setAttribute('data-density', tweak.density)
  const a = ACCENTS[tweak.accent] || ACCENTS.water
  if (tweak.theme === 'dark') {
    root.style.setProperty('--accent', a.dark)
    root.style.setProperty('--accent-soft', a.darkSoft)
    root.style.setProperty('--accent-text', a.dark)
  } else {
    root.style.setProperty('--accent', a.light)
    root.style.setProperty('--accent-soft', a.soft)
    root.style.setProperty('--accent-text', a.text)
  }
}

const loadTweaks = (defaults: Tweaks): Tweaks => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...JSON.parse(raw) }
  } catch (e) {
    return defaults
  }
}

export const useTweaks = (defaults: Tweaks): [Tweaks, (key: keyof Tweaks, value: any) => void] => {
  const [values, setValues] = useState<Tweaks>(() => loadTweaks(defaults))
  const setTweak = useCallback((key: keyof Tweaks, value: any) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch (e) {}
      return next
    })
  }, [])
  return [values, setTweak]
}
