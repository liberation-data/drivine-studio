import { Direction } from '@liberation-data/drivine'
import type {
  FragmentModel, GraphViewModel, PathModel, RelatedModel, RelationshipFragmentModel, RelationshipModel, TargetModel,
} from '@liberation-data/drivine'
import type { Catalog, Fragment, Property, RelationshipFragment, View } from '../studio/api'

/**
 * Drivine's own models of a catalogue's fragments, relationship fragments and views, as its ModelRegistry builds them
 * from decorated classes, so that Drivine writes the Cypher `loadAll` runs for them. Each class is stood in for by an
 * empty one of the same name, which Drivine names in what it says.
 *
 * Built as they are asked for, and each once, so that a view that holds itself, or two that hold each other, refer
 * to the same model.
 */
export class DrivineModels {
  private readonly fragments = new Map<string, FragmentModel>()
  private readonly relationshipFragments = new Map<string, RelationshipFragmentModel>()
  private readonly views = new Map<string, GraphViewModel>()

  constructor(private readonly catalog: Catalog) {}

  /** What a load of the entry with this id loads: a view or a fragment. */
  target(id: string): TargetModel {
    const view = this.catalog.views.find(v => v.id === id)
    if (view) return { kind: 'GRAPH_VIEW', model: this.view(view) }
    const fragment = this.catalog.fragments.find(f => f.id === id)
    if (fragment) return { kind: 'NODE_FRAGMENT', model: this.fragment(fragment) }
    if (this.catalog.relationshipFragments.some(r => r.id === id)) {
      throw new ModelError(`${id} is a relationship fragment, which is loaded as part of a view, not on its own.`)
    }
    throw new ModelError(`No model file the studio read declares ${id}.`)
  }

  private related(id: string, where: string): RelatedModel {
    const relationshipFragment = this.catalog.relationshipFragments.find(r => r.id === id)
    if (relationshipFragment) return { kind: 'RELATIONSHIP_FRAGMENT', model: this.relationshipFragment(relationshipFragment) }
    const view = this.catalog.views.find(v => v.id === id)
    if (view) return { kind: 'GRAPH_VIEW', model: this.view(view) }
    const fragment = this.catalog.fragments.find(f => f.id === id)
    if (fragment) return { kind: 'NODE_FRAGMENT', model: this.fragment(fragment) }
    throw new ModelError(`${where} leads to ${id}, which no model file the studio read declares.`)
  }

  private fragmentById(id: string, where: string): FragmentModel {
    const fragment = this.catalog.fragments.find(f => f.id === id)
    if (!fragment) throw new ModelError(`${where} is ${id}, which no model file the studio read declares as a fragment.`)
    return this.fragment(fragment)
  }

  private fragment(fragment: Fragment): FragmentModel {
    const known = this.fragments.get(fragment.id)
    if (known) return known
    const stored = (name: string) => fragment.properties.find(p => p.name === name)?.stored ?? name
    const model: FragmentModel = {
      type: classNamed(fragment.name),
      labels: fragment.labels,
      ...(fragment.nodeId ? { nodeIdField: fragment.nodeId, nodeIdProperty: stored(fragment.nodeId) } : {}),
      ...(fragment.labelSet
        ? {
            nodeLabels: {
              field: fragment.labelSet.field,
              ...(fragment.labelSet.values ? { members: fragment.labelSet.values } : {}),
              isSet: true,
              recordProperty: `__drivine.labels.${fragment.labelSet.field}`,
            },
          }
        : {}),
      fullTextIndexes: [
        ...(fragment.indexes ?? []).filter(i => i.kind === 'fullText').map(i => i.properties.map(stored)),
        ...fragment.properties.filter(p => p.index === 'fullText').map(p => [p.stored]),
      ],
      vectorFields: new Map(
        fragment.properties
          .filter(p => p.vector)
          .map(p => [p.name, { property: p.stored, similarity: p.vector!.similarity === 'EUCLIDEAN' ? 'EUCLIDEAN' : 'COSINE' }]),
      ),
      propertyBags: (fragment.bags ?? []).map(b => ({ field: b.field, namespace: b.prefix, flat: b.prefix === '' })),
      ...fieldMapping(fragment.properties),
    }
    this.fragments.set(fragment.id, model)
    return model
  }

  private relationshipFragment(entry: RelationshipFragment): RelationshipFragmentModel {
    const known = this.relationshipFragments.get(entry.id)
    if (known) return known
    const models = this
    let target: TargetModel | undefined
    const model: RelationshipFragmentModel = {
      type: classNamed(entry.name),
      targetField: entry.target.field,
      // Resolved on first use, as a view's relationships are, so that it may lead to a view that holds it.
      get target(): TargetModel {
        if (!target) {
          const related = models.related(entry.target.fragment, `${entry.name}.${entry.target.field}`)
          if (related.kind === 'RELATIONSHIP_FRAGMENT') {
            throw new ModelError(`${entry.name}.${entry.target.field} leads to a relationship fragment, which is not a node.`)
          }
          target = related
        }
        return target
      },
      ...fieldMapping(entry.properties),
    }
    this.relationshipFragments.set(entry.id, model)
    return model
  }

  private view(view: View): GraphViewModel {
    const known = this.views.get(view.id)
    if (known) return known
    const models = this
    const model: GraphViewModel = {
      type: classNamed(view.name),
      rootField: view.root.field,
      root: this.fragmentById(view.root.fragment, `${view.name}.${view.root.field}`),
      relationships: [],
      aggregates: (view.aggregates ?? []).map(a => ({
        field: a.field,
        function: a.function,
        type: a.type,
        direction: direction(a.direction),
        ...(a.property ? { property: a.property } : {}),
      })),
      paths: [],
    }
    // Set before the relationships are, so that one leading back to this view finds it.
    this.views.set(view.id, model)
    for (const r of view.relationships) {
      const where = `${view.name}.${r.field}`
      if (r.path) {
        let target: FragmentModel | undefined
        const path: PathModel = {
          field: r.field,
          hops: r.path.map(h => ({
            type: h.type,
            direction: direction(h.direction),
            ...(h.label ? { label: h.label } : {}),
            ...(h.orderBy ? { orderBy: h.orderBy } : {}),
            ascending: h.ascending ?? true,
          })),
          isCollection: r.many,
          required: r.required,
          get target(): FragmentModel {
            return (target ??= models.fragmentById(r.target, where))
          },
        }
        model.paths.push(path)
        continue
      }
      if (!r.type) throw new ModelError(`${where} has neither a relationship type nor a path.`)
      let related: RelatedModel | undefined
      const relationship: RelationshipModel = {
        field: r.field,
        type: r.type,
        direction: direction(r.direction ?? 'OUTGOING'),
        maxDepth: r.maxDepth ?? 1,
        required: r.required,
        isCollection: r.many,
        get related(): RelatedModel {
          return (related ??= models.related(r.target, where))
        },
        // A list of fragments read over several hops names no single relationship a save could write.
        get readOnly(): boolean {
          return !!r.readOnly || ((r.maxDepth ?? 1) > 1 && this.related.kind === 'NODE_FRAGMENT')
        },
        ...(r.sortedBy ? { sortedBy: r.sortedBy } : {}),
      }
      model.relationships.push(relationship)
    }
    return model
  }
}

/** A catalogue that names an entry it does not have, or one a load cannot take: the person can fix it, so a 400. */
export class ModelError extends Error {}

const direction = (value: string): Direction =>
  value === 'INCOMING' ? Direction.INCOMING : value === 'UNDIRECTED' ? Direction.UNDIRECTED : Direction.OUTGOING

/** An empty class of the name, which stands for the class the model file describes. */
function classNamed(name: string): new () => object {
  return { [name]: class {} }[name]!
}

/** How a class's plain fields are stored, from its properties, as FieldMapping has it. */
function fieldMapping(properties: Property[]) {
  return {
    graphProperties: new Map(properties.filter(p => p.stored !== p.name).map(p => [p.name, p.stored])),
    transientFields: new Set<string>(),
    jsonPacked: new Set(properties.filter(p => p.packed === 'json').map(p => p.name)),
    defaults: new Set(properties.filter(p => p.whenAbsent === 'default').map(p => p.name)),
    emptyWhenAbsent: new Map<string, 'array' | 'object'>(
      properties.filter(p => p.whenAbsent === 'empty').map(p => [p.name, p.type === 'map' ? 'object' : 'array']),
    ),
  }
}
