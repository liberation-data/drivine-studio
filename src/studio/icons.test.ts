import { afterEach, describe, expect, it, vi } from 'vitest'
import { byLabel, explainIcons, findIcons, onIconsChanged, refound, refoundAll } from './icons'
import type { LabelIcon } from './icons'

describe('byLabel', () => {
  it("has a label's entry alone, and nothing for a label named as an object's own", () => {
    const icons = byLabel([['Person', 'user'], ['__proto__', 'smile']])
    expect(icons.Person).toBe('user')
    expect(icons['__proto__']).toBe('smile')
    expect(icons.constructor).toBeUndefined()
    expect(icons.toString).toBeUndefined()
  })
})

describe('onIconsChanged', () => {
  it('tells a listener of an icon found again, one label or all, until it stops listening', () => {
    let heard = 0
    const stop = onIconsChanged(() => heard++)
    refound('Person', { icon: 'smile', source: 'chosen' })
    refoundAll()
    stop()
    refound('Person', { icon: 'user', source: 'common' })
    expect(heard).toBe(2)
  })
})

describe('findIcons', () => {
  it('drops what was being found when every icon was forgotten, so a list changed meanwhile gives the new icons', async () => {
    refoundAll()
    let answer: (icons: Record<string, LabelIcon>) => void = () => undefined
    const finding = findIcons(['Probe'], () => new Promise(resolve => (answer = resolve)))
    // A word of their own is added while the first is still being found, as while the model downloads.
    refoundAll()
    answer({ Probe: { icon: null, source: 'none' } })
    await finding
    const asked: string[][] = []
    await findIcons(['Probe'], async labels => {
      asked.push(labels)
      return { Probe: { icon: 'radar', source: 'common' } }
    })
    expect(asked).toEqual([['Probe']])
    // Found now, so not asked again.
    await findIcons(['Probe'], async labels => {
      asked.push(labels)
      return {}
    })
    expect(asked).toEqual([['Probe']])
  })
})

describe('explainIcons', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("has nothing for a label it wasn't asked of named as an object's own, as Settings looks up one not explained yet", async () => {
    vi.stubGlobal('fetch', async () => Response.json({ Person: { icon: 'user', source: 'common', word: 'person', own: false, picks: [] } }))
    const found = await explainIcons(['Person'])
    expect(found.Person?.icon).toBe('user')
    expect(found.constructor).toBeUndefined()
    expect(found.toString).toBeUndefined()
  })
})
