/*
 * Light or dark, or as the system is. The desk's stylesheet and the studio's theme follow the system unless the page's
 * root has `data-theme`, so a choice of light or dark is that attribute, and System is its absence. The choice is kept
 * in this browser only, as the studio's other conveniences are, and set before the page is first drawn (see
 * EARLY_APPEARANCE) so it never flashes the other theme. In the desktop app the app is told too, so the Mac's own menus
 * and dialogs match.
 */

export const APPEARANCES = ['system', 'light', 'dark'] as const
export type Appearance = (typeof APPEARANCES)[number]

export const APPEARANCE_KEY = 'drivine-studio.appearance'

export const isAppearance = (it: unknown): it is Appearance => APPEARANCES.includes(it as Appearance)

/** The appearance chosen, or System when none is, or it can't be read. */
export const appearance = (): Appearance => {
  try {
    const kept = window.localStorage.getItem(APPEARANCE_KEY)
    return isAppearance(kept) ? kept : 'system'
  } catch {
    return 'system'
  }
}

/** The page's root as the appearance has it: `data-theme` for light or dark, none for System. */
export const applyAppearance = (chosen: Appearance, root: HTMLElement = document.documentElement) => {
  if (chosen === 'system') {
    root.removeAttribute('data-theme')
    root.style.removeProperty('color-scheme')
  } else {
    root.setAttribute('data-theme', chosen)
    root.style.setProperty('color-scheme', chosen)
  }
  window.studioNative?.setTheme?.(chosen)
}

const listeners = new Set<() => void>()

/** Chooses an appearance: kept, put on the page at once, and told to whatever draws in the theme's colours. */
export const setAppearance = (chosen: Appearance) => {
  try {
    window.localStorage.setItem(APPEARANCE_KEY, chosen)
  } catch {
    // Not kept; it is System again next time.
  }
  applyAppearance(chosen)
  for (const listener of listeners) listener()
}

/**
 * Calls the listener when the theme the page is drawn in may have changed: another appearance chosen, or the system's
 * own changing while System is. For what can't read CSS, such as a canvas, to read the desk's colours again.
 */
export const onThemeChange = (listener: () => void): (() => void) => {
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  listeners.add(listener)
  scheme.addEventListener('change', listener)
  return () => {
    listeners.delete(listener)
    scheme.removeEventListener('change', listener)
  }
}

/** Calls the listener when another appearance is chosen. (No React here: the page's layout, on the server, reads this file.) */
export const onAppearanceChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The same as applyAppearance, as a script run in the page's head before anything is drawn: the root gets its
 * `data-theme` before the first paint, rather than after React has started. The desktop app is told later, once the
 * studio has started (see App).
 */
export const EARLY_APPEARANCE = `try{var a=localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)});if(a==='light'||a==='dark'){document.documentElement.setAttribute('data-theme',a);document.documentElement.style.setProperty('color-scheme',a)}}catch(e){}`
