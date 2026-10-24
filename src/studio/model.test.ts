import { describe, expect, it } from 'vitest'
import type { Catalog, FragmentDescriptor, PropertyDescriptor, ViewDescriptor } from './api'
import { emptyDraft, nextSubject, operatorsFor, scopesOf, subjectKey, toQuery } from './model'
import type { ConditionDraft, Subject } from './model'

const property = (name: string, type: string, javaType: string, vector = false): PropertyDescriptor =>
  ({ name, type, javaType, nullable: true, vector })

const person: FragmentDescriptor = {
  name: 'Person',
  className: 'sample.Person',
  labels: ['Person'],
  idProperty: 'uuid',
  properties: [
    property('uuid', 'UUID', 'java.util.UUID'),
    property('name', 'String', 'java.lang.String'),
    property('age', 'Int', 'int'),
    property('embedding', 'FloatArray', '[F', true),
  ],
}
const organization: FragmentDescriptor = {
  name: 'Organization',
  className: 'sample.Organization',
  labels: ['Organization'],
  idProperty: 'uuid',
  properties: [property('uuid', 'UUID', 'java.util.UUID'), property('name', 'String', 'java.lang.String')],
}
const relationship = (field: string, filterOn: string | null) => ({
  field, type: 'WORKS_FOR', direction: 'OUTGOING' as const, target: 'sample.Organization', targetIsView: false,
  filterOn, collection: true, nullable: false, edgeProperties: [], recursive: false,
})
const view: ViewDescriptor = {
  name: 'PersonContext',
  className: 'sample.PersonContext',
  root: { field: 'person', fragment: 'sample.Person' },
  relationships: [relationship('employer', 'sample.Organization'), relationship('memberships', null)],
  aggregates: [],
}
const catalog: Catalog = { views: [view], fragments: [organization, person], problems: [] }
const onView: Subject = { kind: 'view', view }
const onFragment: Subject = { kind: 'fragment', fragment: person }

const row = (patch: Partial<ConditionDraft>): ConditionDraft =>
  ({ key: 1, scope: '', quantifier: 'any', property: 'name', op: 'EQUALS', value: '', ...patch })

describe('scopesOf', () => {
  it('offers a fragment its own properties, leaving out embeddings', () => {
    const scopes = scopesOf(onFragment, catalog)
    expect(scopes.map(s => s.id)).toEqual([''])
    expect(scopes[0]?.properties.map(p => p.name)).toEqual(['uuid', 'name', 'age'])
  })

  it('offers a view its root and each relationship that takes a condition', () => {
    const scopes = scopesOf(onView, catalog)
    expect(scopes.map(s => [s.id, s.label])).toEqual([['', 'person'], ['employer', 'employer']])
    expect(scopes[1]?.properties.map(p => p.name)).toEqual(['uuid', 'name'])
  })

  it('offers a root missing from the catalogue no properties, rather than failing', () => {
    const scopes = scopesOf(onView, { ...catalog, fragments: [] })
    expect(scopes).toEqual([{ id: '', label: 'person', properties: [] }])
  })
})

describe('operatorsFor', () => {
  const values = (p: PropertyDescriptor | undefined) => operatorsFor(p).map(o => o.value)

  it('offers text the text comparisons', () => {
    expect(values(property('name', 'String', 'java.lang.String'))).toContain('CONTAINS_IGNORE_CASE')
  })

  it('offers a number the ordered comparisons and no text ones', () => {
    const offered = values(property('age', 'Int', 'int'))
    expect(offered).toContain('GREATER_THAN')
    expect(offered).not.toContain('CONTAINS')
  })

  it.each([
    ['a Kotlin Boolean', 'Boolean', 'boolean'],
    ['a Java boolean', 'boolean', 'boolean'],
    ['a Java Boolean', 'Boolean', 'java.lang.Boolean'],
  ])('offers %s only is, is not, absent and present', (_, type, javaType) => {
    expect(values(property('active', type, javaType))).toEqual(['EQUALS', 'NOT_EQUALS', 'IS_NULL', 'IS_NOT_NULL'])
  })

  it('offers is and is not when the property is unknown', () => {
    expect(values(undefined)).toEqual(['EQUALS', 'NOT_EQUALS'])
  })
})

describe('toQuery', () => {
  it('loads a fragment unfiltered, at the default limit', () => {
    expect(toQuery(onFragment, emptyDraft(), catalog)).toEqual({ type: 'sample.Person', where: [], orderBy: [], limit: 50 })
  })

  it('sends one value as text, a list split on commas, and none for absent', () => {
    const draft = {
      ...emptyDraft(),
      conditions: [
        row({ property: 'age', op: 'GREATER_THAN', value: '30' }),
        row({ property: 'name', op: 'IN', value: 'Ada, ,Grace ' }),
        row({ property: 'name', op: 'IS_NULL', value: 'ignored' }),
      ],
    }
    expect(toQuery(onFragment, draft, catalog).where).toEqual([
      { kind: 'property', property: 'age', op: 'GREATER_THAN', value: '30' },
      { kind: 'property', property: 'name', op: 'IN', value: ['Ada', 'Grace'] },
      { kind: 'property', property: 'name', op: 'IS_NULL' },
    ])
  })

  it('wraps a condition on a relationship as related, with none when asked', () => {
    const draft = {
      ...emptyDraft(),
      conditions: [
        row({ scope: 'employer', value: 'Acme' }),
        row({ key: 2, scope: 'employer', quantifier: 'none', value: 'Initech' }),
      ],
    }
    expect(toQuery(onView, draft, catalog).where).toEqual([
      { kind: 'related', relationship: 'employer', none: false, conditions: [{ kind: 'property', property: 'name', op: 'EQUALS', value: 'Acme' }] },
      { kind: 'related', relationship: 'employer', none: true, conditions: [{ kind: 'property', property: 'name', op: 'EQUALS', value: 'Initech' }] },
    ])
  })

  it('leaves out a row whose scope or property is not in the catalogue', () => {
    const draft = {
      ...emptyDraft(),
      conditions: [row({ scope: 'memberships' }), row({ property: '' }), row({ property: 'embedding' })],
    }
    expect(toQuery(onView, draft, catalog).where).toEqual([])
  })

  it('orders by the chosen property and leaves out a limit that is not a number', () => {
    const query = toQuery(onView, { ...emptyDraft(), orderBy: 'age', direction: 'DESC', limit: '' }, catalog)
    expect(query).toEqual({ type: 'sample.PersonContext', where: [], orderBy: [{ property: 'age', direction: 'DESC' }] })
  })
})

describe('subjectKey', () => {
  it('tells apart two classes with the same simple name', () => {
    const other: Subject = { kind: 'fragment', fragment: { ...person, className: 'other.Person' } }
    expect(subjectKey(onFragment)).not.toEqual(subjectKey(other))
  })

  it('tells a view apart from a fragment', () => {
    expect(subjectKey(onView)).not.toEqual(subjectKey({ kind: 'fragment', fragment: { ...person, className: view.className } }))
  })
})

describe('nextSubject', () => {
  it('keeps the subject on the canvas when the same one is shown again, so its query is not run afresh', () => {
    const again: Subject = { kind: 'view', view: { ...view } }
    expect(nextSubject(onView, again)).toBe(onView)
  })

  it('takes a different subject, or none', () => {
    expect(nextSubject(onView, onFragment)).toBe(onFragment)
    expect(nextSubject(null, onView)).toBe(onView)
    expect(nextSubject(onView, null)).toBeNull()
  })
})
