import type { Catalog, Condition, Fragment, Operator, Property, Query, View } from './api'

/** What is on the canvas: a view or a fragment from the catalogue. */
export type Subject =
  | { kind: 'view'; view: View }
  | { kind: 'fragment'; fragment: Fragment }

export const subjectName = (subject: Subject): string =>
  subject.kind === 'view' ? subject.view.name : subject.fragment.name

/** The id of the view or fragment: its class's whole name, which two packages' classes of one simple name differ by. */
export const subjectId = (subject: Subject): string => (subject.kind === 'view' ? subject.view.id : subject.fragment.id)

/** Tells subjects apart by id. */
export const subjectKey = (subject: Subject): string => `${subject.kind}:${subjectId(subject)}`

/**
 * What the canvas shows once next is asked for. The catalogue makes a new object for the subject on each
 * render, and the canvas reloads, unfiltered, whenever its subject changes; so showing what is already
 * there keeps the current object, and with it the query and the result that match the form.
 */
export const nextSubject = (current: Subject | null, next: Subject | null): Subject | null =>
  current && next && subjectKey(current) === subjectKey(next) ? current : next

/** Where a condition looks: the root, or the node at the far end of a relationship. */
export interface Scope {
  /** '' for the root; otherwise the relationship's field. */
  id: string
  label: string
  properties: Property[]
}

/**
 * The root, and each relationship a query can look along: one that leads to a fragment, a view (by its root) or a
 * relationship fragment (by the node it leads to). A path is not one yet, as Drivine's query DSL does not look along
 * one.
 */
export function scopesOf(subject: Subject, catalog: Catalog): Scope[] {
  const fragment = (id: string) => {
    const view = catalog.views.find(v => v.id === id)
    return catalog.fragments.find(f => f.id === (view ? view.root.fragment : id))
  }
  if (subject.kind === 'fragment') {
    return [{ id: '', label: subject.fragment.name, properties: filterable(subject.fragment) }]
  }
  const root = fragment(subject.view.root.fragment)
  const scopes: Scope[] = [{ id: '', label: subject.view.root.field, properties: root ? filterable(root) : [] }]
  for (const relationship of subject.view.relationships) {
    if (relationship.path) continue
    const relationshipFragment = catalog.relationshipFragments.find(r => r.id === relationship.target)
    const target = fragment(relationshipFragment ? relationshipFragment.target.fragment : relationship.target)
    if (target) scopes.push({ id: relationship.field, label: relationship.field, properties: filterable(target) })
  }
  return scopes
}

/**
 * What a condition can compare: not an embedding, which is searched by similarity, which the studio does not do yet;
 * nor a value packed as JSON, a map, a list, or one of a type the library could not name.
 */
const filterable = (fragment: Fragment) =>
  fragment.properties.filter(p => !p.vector && !p.packed && !['list', 'map', 'json', 'any'].includes(p.type))

export interface OperatorChoice {
  value: Operator
  label: string
  /** none: takes no value. list: several, separated by commas. */
  operand: 'one' | 'list' | 'none'
}

const COMMON: OperatorChoice[] = [
  { value: 'EQ', label: 'is', operand: 'one' },
  { value: 'NEQ', label: 'is not', operand: 'one' },
]
const TEXT: OperatorChoice[] = [
  { value: 'CONTAINS', label: 'contains', operand: 'one' },
  { value: 'CONTAINS_IGNORE_CASE', label: 'contains, any case', operand: 'one' },
  { value: 'STARTS_WITH', label: 'starts with', operand: 'one' },
  { value: 'ENDS_WITH', label: 'ends with', operand: 'one' },
]
const ORDERED: OperatorChoice[] = [
  { value: 'GT', label: 'is more than', operand: 'one' },
  { value: 'GTE', label: 'is at least', operand: 'one' },
  { value: 'LT', label: 'is less than', operand: 'one' },
  { value: 'LTE', label: 'is at most', operand: 'one' },
]
const REST: OperatorChoice[] = [
  { value: 'IN', label: 'is one of', operand: 'list' },
  { value: 'NOT_IN', label: 'is none of', operand: 'list' },
  { value: 'IS_NULL', label: 'is absent', operand: 'none' },
  { value: 'IS_NOT_NULL', label: 'is present', operand: 'none' },
]

export function operatorsFor(property: Property | undefined): OperatorChoice[] {
  if (!property) return COMMON
  if (property.type === 'string') return [...COMMON, ...TEXT, ...REST]
  if (property.type === 'boolean') return [...COMMON, ...REST.slice(2)]
  // Ids and enum members are told apart by what they are, not ordered.
  if (property.type === 'uuid' || property.type === 'enum') return [...COMMON, ...REST]
  return [...COMMON, ...ORDERED, ...REST]
}

/** One row of the where clause as the person edits it. */
export interface ConditionDraft {
  key: number
  scope: string
  /** Only for a relationship: 'none' asks that no related node matches. */
  quantifier: 'any' | 'none'
  property: string
  op: Operator
  value: string
}

export interface QueryDraft {
  conditions: ConditionDraft[]
  orderBy: string
  direction: 'ASC' | 'DESC'
  limit: string
}

export const emptyDraft = (): QueryDraft => ({ conditions: [], orderBy: '', direction: 'ASC', limit: '50' })

/** The draft as the query the endpoint takes. A row with no property yet is left out. */
export function toQuery(subject: Subject, draft: QueryDraft, catalog: Catalog): Query {
  const scopes = scopesOf(subject, catalog)
  const where: Condition[] = []
  for (const row of draft.conditions) {
    const scope = scopes.find(s => s.id === row.scope)
    const property = scope?.properties.find(p => p.name === row.property)
    if (!scope || !property) continue
    const operand = operatorsFor(property).find(o => o.value === row.op)?.operand ?? 'one'
    const condition: Condition = { kind: 'property', property: row.property, op: row.op }
    // The server turns each value into the property's own type, so text is all the browser sends.
    if (operand === 'one') condition.value = row.value
    if (operand === 'list') condition.value = row.value.split(',').map(v => v.trim()).filter(v => v !== '')
    where.push(
      scope.id === ''
        ? condition
        : { kind: 'related', relationship: scope.id, none: row.quantifier === 'none', conditions: [condition] },
    )
  }
  const limit = Number.parseInt(draft.limit, 10)
  return {
    type: subjectId(subject),
    where,
    orderBy: draft.orderBy ? [{ property: draft.orderBy, direction: draft.direction }] : [],
    ...(Number.isFinite(limit) ? { limit } : {}),
  }
}
