import { describe, expect, it } from 'vitest'
import type { StudioConnection } from './database'
import { askingOf, explainedWith, labelsOf, matchesOf, reason, rowsOf, shownOf } from './IconSettings'

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

describe('rowsOf', () => {
  const found = { Movie: { icon: 'film', source: 'common' as const, picks: [] }, Probe: { icon: null, source: 'none' as const, picks: [] } }
  const seen = [{ label: 'Movie', connections: ['A'] }, { label: 'Probe', connections: ['A'] }]

  it('finds a label by part of its name, and shows only those without an icon when asked', () => {
    expect(rowsOf(seen, found, ' ov ', 'all').map(it => it.label)).toEqual(['Movie'])
    expect(rowsOf(seen, found, '', 'none').map(it => it.label)).toEqual(['Probe'])
    expect(rowsOf(seen, null, '', 'all').map(it => it.found)).toEqual([undefined, undefined])
  })

  it('shows only the first 500, the labels explained, as the note under the table says', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ label: `L${String(i).padStart(3, '0')}`, connections: [] }))
    const rows = rowsOf(many, null, '', 'all')
    expect(rows).toHaveLength(500)
    expect(rows.at(-1)?.label).toBe('L499')
  })

  it('finds a label past the first 500 by search, as the labels shown are those it finds', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ label: `L${String(i).padStart(3, '0')}`, connections: [] }))
    expect(shownOf(many, 'L500').map(it => it.label)).toEqual(['L500'])
    expect(rowsOf(many, null, 'L500', 'all').map(it => it.label)).toEqual(['L500'])
  })
})

describe('matchesOf', () => {
  it('gives every label the search finds, past the first 500 too, as the note under the table counts them', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ label: `L${String(i).padStart(4, '0')}`, connections: [] }))
    expect(matchesOf(many, '')).toHaveLength(1200)
    expect(matchesOf(many, 'l0')).toHaveLength(1000)
    expect(shownOf(many, 'l0')).toHaveLength(500)
    expect(matchesOf(many, 'L11')).toHaveLength(100)
  })
})

describe('explainedWith', () => {
  const film = { icon: 'film', source: 'common' as const, picks: [] }
  const none = { icon: null, source: 'none' as const, picks: [] }

  it('adds an answer to what was explained since the same change, and starts again after a change', () => {
    const first = explainedWith(null, 0, { Movie: film })
    expect(explainedWith(first, 0, { Probe: none })).toEqual({ changes: 0, found: { Movie: film, Probe: none } })
    expect(explainedWith(first, 1, { Probe: none })).toEqual({ changes: 1, found: { Probe: none } })
  })

  it('drops an answer from before a change that arrives after the answer since it', () => {
    const since = explainedWith(null, 2, { Movie: film })
    expect(explainedWith(since, 1, { Movie: none })).toBe(since)
  })

  it('reads a label named as an object is born with as a label', () => {
    expect(explainedWith(null, 0, { Movie: film }).found.constructor).toBeUndefined()
  })
})

describe('askingOf', () => {
  const film = { icon: 'film', source: 'common' as const, picks: [] }
  const shown = [{ label: 'Movie', connections: ['A'] }, { label: 'Probe', connections: ['A'] }]

  it('asks for the labels shown not explained since the last change, and every one shown after a change', () => {
    const since = explainedWith(null, 3, { Movie: film })
    expect(askingOf(shown, null, 0)).toEqual(['Movie', 'Probe'])
    expect(askingOf(shown, since, 3)).toEqual(['Probe'])
    expect(askingOf(shown, since, 4)).toEqual(['Movie', 'Probe'])
    expect(askingOf([{ label: 'constructor', connections: [] }], since, 3)).toEqual(['constructor'])
  })

  it('asks for nothing when no label is shown, so the table says so rather than waiting for an answer', () => {
    expect(askingOf([], null, 0)).toEqual([])
  })
})
