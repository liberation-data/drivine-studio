import { afterEach, describe, expect, it, vi } from 'vitest'
import { remembered } from './Settings'

const keeping = (kept: string | null) =>
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => (key === 'drivine-studio.settings.section' ? kept : null) } })

afterEach(() => vi.unstubAllGlobals())

describe('remembered', () => {
  it('opens on the section used last', () => {
    keeping('icons')
    expect(remembered()).toBe('icons')
  })

  it('opens on Appearance when none was kept, or the one kept is Connections, which has its own window now', () => {
    keeping(null)
    expect(remembered()).toBe('appearance')
    keeping('connections')
    expect(remembered()).toBe('appearance')
  })

  it('opens on Appearance when the store cannot be read', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied') } } })
    expect(remembered()).toBe('appearance')
  })
})
