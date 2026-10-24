import type { Catalog, Condition, FragmentDescriptor, Operator, PropertyDescriptor, Query, ViewDescriptor } from './api'

/** What is on the canvas: a view or a fragment from the catalogue. */
export type Subject =
  | { kind: 'view'; view: ViewDescriptor }
  | { kind: 'fragment'; fragment: FragmentDescriptor }

export const subjectName = (subject: Subject): string =>
  subject.kind === 'view' ? subject.view.name : subject.fragment.name

export const subjectClass = (subject: Subject): string =>
  subject.kind === 'view' ? subject.view.className : subject.fragment.className

/** Where a condition looks: the root, or the node at the far end of a relationship. */
export interface Scope {
  /** '' for the root; otherwise the relationship's field. */
  id: string
  label: string
  properties: PropertyDescriptor[]
}

export function scopesOf(subject: Subject, catalog: Catalog): Scope[] {
  const fragment = (className: string) => catalog.fragments.find(f => f.className === className)
  if (subject.kind === 'fragment') {
    return [{ id: '', label: subject.fragment.name, properties: filterable(subject.fragment) }]
  }
  const root = fragment(subject.view.root.fragment)
  const scopes: Scope[] = [{ id: '', label: subject.view.root.field, properties: root ? filterable(root) : [] }]
  for (const relationship of subject.view.relationships) {
    const target = relationship.filterOn ? fragment(relationship.filterOn) : undefined
    if (target) scopes.push({ id: relationship.field, label: relationship.field, properties: filterable(target) })
  }
  return scopes
}

// An embedding is searched by similarity, which the studio does not do yet; it is never compared.
const filterable = (fragment: FragmentDescriptor) => fragment.properties.filter(p => !p.vector)

export interface OperatorChoice {
  value: Operator
  label: string
  /** none: takes no value. list: several, separated by commas. */
  operand: 'one' | 'list' | 'none'
}

const COMMON: OperatorChoice[] = [
  { value: 'EQUALS', label: 'is', operand: 'one' },
  { value: 'NOT_EQUALS', label: 'is not', operand: 'one' },
]
const TEXT: OperatorChoice[] = [
  { value: 'CONTAINS', label: 'contains', operand: 'one' },
  { value: 'CONTAINS_IGNORE_CASE', label: 'contains, any case', operand: 'one' },
  { value: 'STARTS_WITH', label: 'starts with', operand: 'one' },
  { value: 'ENDS_WITH', label: 'ends with', operand: 'one' },
]
const ORDERED: OperatorChoice[] = [
  { value: 'GREATER_THAN', label: 'is more than', operand: 'one' },
  { value: 'GREATER_THAN_OR_EQUAL', label: 'is at least', operand: 'one' },
  { value: 'LESS_THAN', label: 'is less than', operand: 'one' },
  { value: 'LESS_THAN_OR_EQUAL', label: 'is at most', operand: 'one' },
]
const REST: OperatorChoice[] = [
  { value: 'IN', label: 'is one of', operand: 'list' },
  { value: 'NOT_IN', label: 'is none of', operand: 'list' },
  { value: 'IS_NULL', label: 'is absent', operand: 'none' },
  { value: 'IS_NOT_NULL', label: 'is present', operand: 'none' },
]

export function operatorsFor(property: PropertyDescriptor | undefined): OperatorChoice[] {
  if (!property) return COMMON
  if (property.javaType === 'java.lang.String') return [...COMMON, ...TEXT, ...REST]
  if (property.type === 'Boolean') return [...COMMON, ...REST.slice(2)]
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
    // The endpoint turns each value into the property's own type, so text is all the browser sends.
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
    type: subjectClass(subject),
    where,
    orderBy: draft.orderBy ? [{ property: draft.orderBy, direction: draft.direction }] : [],
    ...(Number.isFinite(limit) ? { limit } : {}),
  }
}
