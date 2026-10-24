import { describe, expect, it } from 'vitest'
import type { Catalog, Fragment, Property, View } from './api'
import { emptyDraft, nextSubject, operatorsFor, scopesOf, subjectKey, toQuery } from './model'
import type { ConditionDraft, Subject } from './model'

const property = (name: string, type: Property['type'], extra: Partial<Property> = {}): Property =>
  ({ name, stored: name, type, nullable: true, ...extra })

const person: Fragment = {
  id: 'sample.Person',
  name: 'Person',
  module: 'sample',
  labels: ['Person'],
  nodeId: 'uuid',
  properties: [
    property('age', 'int'),
    property('embedding', 'list', { of: 'float', vector: { similarity: 'COSINE' } }),
    property('name', 'string'),
    property('tags', 'list', { of: 'string', packed: 'json' }),
    property('uuid', 'uuid'),
  ],
}
const organization: Fragment = {
  id: 'sample.Organization',
  name: 'Organization',
  module: 'sample',
  labels: ['Organization'],
  properties: [property('name', 'string'), property('uuid', 'uuid')],
}
const view: View = {
  id: 'sample.PersonContext',
  name: 'PersonContext',
  module: 'sample',
  root: { field: 'person', fragment: 'sample.Person' },
  relationships: [
    { field: 'employer', type: 'WORKS_FOR', direction: 'OUTGOING', target: 'sample.Organization', many: true, required: false },
    { field: 'history', type: 'WORKED_FOR', direction: 'OUTGOING', target: 'sample.WorkHistory', many: true, required: false },
    { field: 'far', target: 'sample.Organization', many: true, required: false, path: [{ type: 'A', direction: 'OUTGOING' }] },
  ],
}
const catalog: Catalog = {
  models: [],
  fragments: [organization, person],
  relationshipFragments: [
    { id: 'sample.WorkHistory', name: 'WorkHistory', module: 'sample', target: { field: 'target', fragment: 'sample.Organization' }, properties: [] },
  ],
  views: [view],
  problems: [],
}
const onView: Subject = { kind: 'view', view }
const onFragment: Subject = { kind: 'fragment', fragment: person }

const row = (patch: Partial<ConditionDraft>): ConditionDraft =>
  ({ key: 1, scope: '', quantifier: 'any', property: 'name', op: 'EQ', value: '', ...patch })

describe('scopesOf', () => {
  it('offers a fragment the properties a condition can compare: not an embedding, a packed value or a list', () => {
    const scopes = scopesOf(onFragment, catalog)
    expect(scopes.map(s => s.id)).toEqual([''])
    expect(scopes[0]?.properties.map(p => p.name)).toEqual(['age', 'name', 'uuid'])
  })

  it('offers a view its root, and each relationship but a path, a relationship fragment by the node it leads to', () => {
    const scopes = scopesOf(onView, catalog)
    expect(scopes.map(s => [s.id, s.label])).toEqual([['', 'person'], ['employer', 'employer'], ['history', 'history']])
    expect(scopes[2]?.properties.map(p => p.name)).toEqual(['name', 'uuid'])
  })

  it('offers a root missing from the catalogue no properties, rather than failing', () => {
    expect(scopesOf(onView, { ...catalog, fragments: [] })).toEqual([{ id: '', label: 'person', properties: [] }])
  })
})

describe('operatorsFor', () => {
  const values = (p: Property | undefined) => operatorsFor(p).map(o => o.value)

  it('offers text the text comparisons', () => {
    expect(values(property('name', 'string'))).toContain('CONTAINS_IGNORE_CASE')
  })

  it('offers a number or a date the ordered comparisons and no text ones', () => {
    for (const type of ['int', 'float', 'datetime'] as const) {
      expect(values(property('x', type))).toContain('GT')
      expect(values(property('x', type))).not.toContain('CONTAINS')
    }
  })

  it('offers an id or an enum is, is not, is one of, and absent or present, unordered', () => {
    expect(values(property('uuid', 'uuid'))).toEqual(['EQ', 'NEQ', 'IN', 'NOT_IN', 'IS_NULL', 'IS_NOT_NULL'])
    expect(values(property('state', 'enum'))).not.toContain('GT')
  })

  it('offers a boolean only is, is not, absent and present', () => {
    expect(values(property('active', 'boolean'))).toEqual(['EQ', 'NEQ', 'IS_NULL', 'IS_NOT_NULL'])
  })

  it('offers is and is not when the property is unknown', () => {
    expect(values(undefined)).toEqual(['EQ', 'NEQ'])
  })
})

describe('toQuery', () => {
  it('loads a fragment by its id, unfiltered, at the default limit', () => {
    expect(toQuery(onFragment, emptyDraft(), catalog)).toEqual({ type: 'sample.Person', where: [], orderBy: [], limit: 50 })
  })

  it('sends one value as text, a list split on commas, and none for absent', () => {
    const draft = {
      ...emptyDraft(),
      conditions: [
        row({ property: 'age', op: 'GT', value: '30' }),
        row({ property: 'name', op: 'IN', value: 'Ada, ,Grace ' }),
        row({ property: 'name', op: 'IS_NULL', value: 'ignored' }),
      ],
    }
    expect(toQuery(onFragment, draft, catalog).where).toEqual([
      { kind: 'property', property: 'age', op: 'GT', value: '30' },
      { kind: 'property', property: 'name', op: 'IN', value: ['Ada', 'Grace'] },
      { kind: 'property', property: 'name', op: 'IS_NULL' },
    ])
  })

  it('wraps a condition on a relationship as related, with none when asked', () => {
    const draft = {
      ...emptyDraft(),
      conditions: [row({ scope: 'employer', value: 'Acme' }), row({ key: 2, scope: 'employer', quantifier: 'none', value: 'Initech' })],
    }
    expect(toQuery(onView, draft, catalog).where).toEqual([
      { kind: 'related', relationship: 'employer', none: false, conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Acme' }] },
      { kind: 'related', relationship: 'employer', none: true, conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Initech' }] },
    ])
  })

  it('leaves out a row whose scope or property is not one a condition can take', () => {
    const draft = { ...emptyDraft(), conditions: [row({ scope: 'far' }), row({ property: '' }), row({ property: 'embedding' })] }
    expect(toQuery(onView, draft, catalog).where).toEqual([])
  })

  it('orders by the chosen property and leaves out a limit that is not a number', () => {
    const query = toQuery(onView, { ...emptyDraft(), orderBy: 'age', direction: 'DESC', limit: '' }, catalog)
    expect(query).toEqual({ type: 'sample.PersonContext', where: [], orderBy: [{ property: 'age', direction: 'DESC' }] })
  })
})

describe('subjectKey', () => {
  it('tells apart two classes with the same simple name', () => {
    const other: Subject = { kind: 'fragment', fragment: { ...person, id: 'other.Person' } }
    expect(subjectKey(onFragment)).not.toEqual(subjectKey(other))
  })

  it('tells a view apart from a fragment', () => {
    expect(subjectKey(onView)).not.toEqual(subjectKey({ kind: 'fragment', fragment: { ...person, id: view.id } }))
  })
})

describe('nextSubject', () => {
  it('keeps the subject on the canvas when the same one is shown again, so its query is not run afresh', () => {
    expect(nextSubject(onView, { kind: 'view', view: { ...view } })).toBe(onView)
  })

  it('takes a different subject, or none', () => {
    expect(nextSubject(onView, onFragment)).toBe(onFragment)
    expect(nextSubject(null, onView)).toBe(onView)
    expect(nextSubject(onView, null)).toBeNull()
  })
})
