import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_KEY, appearance, applyAppearance, EARLY_APPEARANCE, onAppearanceChange, onThemeChange, setAppearance } from './appearance'

// No DOM here: a root, a store and the system's scheme, as small as appearance.ts needs them.
const rootOf = () => {
  const attributes = new Map<string, string>()
  const style = new Map<string, string>()
  return {
    attributes,
    style,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    style_: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
  }
}

let root: ReturnType<typeof rootOf>
let stored: Map<string, string>
let scheme: Set<() => void>
let told: string[]

beforeEach(() => {
  root = rootOf()
  stored = new Map()
  scheme = new Set()
  told = []
  const element = { ...root, style: root.style_ }
  vi.stubGlobal('document', { documentElement: element })
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    matchMedia: () => ({ addEventListener: (_: string, f: () => void) => scheme.add(f), removeEventListener: (_: string, f: () => void) => scheme.delete(f) }),
    studioNative: { setTheme: (theme: string) => told.push(theme) },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('appearance', () => {
  it('is System until one is chosen, and when what is kept is not one of the three', () => {
    expect(appearance()).toBe('system')
    stored.set(APPEARANCE_KEY, 'sepia')
    expect(appearance()).toBe('system')
  })

  it('is System when the store cannot be read', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied') } } })
    expect(appearance()).toBe('system')
  })

  it('puts light or dark on the root, and System takes it off, telling the desktop app each time', () => {
    applyAppearance('dark')
    expect(root.attributes.get('data-theme')).toBe('dark')
    expect(root.style.get('color-scheme')).toBe('dark')
    applyAppearance('system')
    expect(root.attributes.has('data-theme')).toBe(false)
    expect(root.style.has('color-scheme')).toBe(false)
    expect(told).toEqual(['dark', 'system'])
  })

  it('keeps a choice, applies it, and tells those listening', () => {
    const heard = vi.fn()
    const stop = onAppearanceChange(heard)
    setAppearance('light')
    expect(stored.get(APPEARANCE_KEY)).toBe('light')
    expect(appearance()).toBe('light')
    expect(root.attributes.get('data-theme')).toBe('light')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    setAppearance('dark')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('applies a choice and tells those listening when the store cannot keep it, outside the desktop app', () => {
    vi.stubGlobal('window', { localStorage: { setItem: () => { throw new Error('full') }, getItem: () => null } })
    const heard = vi.fn()
    const stop = onAppearanceChange(heard)
    setAppearance('dark')
    stop()
    expect(root.attributes.get('data-theme')).toBe('dark')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(appearance()).toBe('system')
  })

  it('tells a theme listener of a choice and of the system changing, until it stops', () => {
    const heard = vi.fn()
    const stop = onThemeChange(heard)
    setAppearance('dark')
    for (const f of scheme) f()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    expect(scheme.size).toBe(0)
    setAppearance('light')
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it("sets the head's early script to what applyAppearance would, and leaves System alone", () => {
    const run = new Function('localStorage', 'document', EARLY_APPEARANCE) as (s: unknown, d: unknown) => void
    const element = { ...root, style: root.style_ }
    run({ getItem: () => 'dark' }, { documentElement: element })
    expect(root.attributes.get('data-theme')).toBe('dark')
    expect(root.style.get('color-scheme')).toBe('dark')
    const plain = rootOf()
    run({ getItem: () => 'system' }, { documentElement: { ...plain, style: plain.style_ } })
    expect(plain.attributes.size).toBe(0)
    run({ getItem: () => { throw new Error('denied') } }, { documentElement: { ...plain, style: plain.style_ } })
    expect(plain.attributes.size).toBe(0)
  })
})
