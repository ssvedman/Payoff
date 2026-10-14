import { useCallback, useState } from 'react'

/**
 * Light / dark / follow the device.
 *
 * Per device, not per person: it is a property of the screen being looked at,
 * so it lives in localStorage rather than in the database. The inline script in
 * index.html applies the same key before first paint; keep the two in step.
 */
export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'payoff-theme'

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  const set = useCallback((c: ThemeChoice) => {
    setChoice(c)
    apply(c)
    try {
      if (c === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, c)
    } catch {
      // Storage refused (private window). The choice still holds for this visit.
    }
  }, [])
  return [choice, set]
}
