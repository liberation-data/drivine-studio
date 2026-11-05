import { describe, expect, it } from 'vitest'
import type { StudioConnection } from './database'
import { labelsOf, reason } from './IconSettings'

const connection = (id: string, name: string) => ({ id, name, type: 'NEO4J', host: 'localhost' }) as StudioConnection
const schema = (labels: string[]) => ({ labels, relationshipTypes: [], propertyKeys: [] })

describe('labelsOf', () => {
  it("gathers each label once, by name, with the connections whose graphs have it, and those chosen in none", () => {
    const labels = labelsOf(
      [connection('a', 'A'), connection('b', 'B'), connection('c', 'C')],
      { a: schema(['Person', 'Movie']), b: schema(['Person']) },
      { Metro: 'square-m', Person: 'smile' },
    )
    expect(labels).toEqual([
      { label: 'Metro', connections: [] },
      { label: 'Movie', connections: ['A'] },
      { label: 'Person', connections: ['A', 'B'] },
    ])
  })

  it('takes a label named as an object is born with for a label', () => {
    expect(labelsOf([connection('a', 'A')], { a: schema(['constructor']) }, JSON.parse('{"__proto__":null}'))).toEqual([
      { label: '__proto__', connections: [] },
      { label: 'constructor', connections: ['A'] },
    ])
  })
})

describe('reason', () => {
  it('says why a label has its icon, with the word or score behind it', () => {
    expect(reason({ icon: 'smile', source: 'chosen', picks: [] }, 0.45)).toBe('Chosen')
    expect(reason({ icon: null, source: 'chosen', picks: [] }, 0.45)).toBe('Chosen to have none')
    expect(reason({ icon: 'user', source: 'common', word: 'person', own: false, picks: [] }, 0.45)).toBe('Common word “person”')
    expect(reason({ icon: 'radar', source: 'common', word: 'probe', own: true, picks: [] }, 0.45)).toBe('Your word “probe”')
    expect(reason({ icon: 'flask-conical', source: 'nearest', score: 0.612, picks: [] }, 0.45)).toBe('Model, 0.61')
    expect(reason({ icon: null, source: 'none', score: 0.3, picks: [{ icon: 'cat', score: 0.3 }] }, 0.45)).toBe('None: nearest 0.30, under 0.45')
    expect(reason({ icon: null, source: 'none', picks: [] }, 0.45)).toBe('None: no model yet, or no word in the label')
  })
})
