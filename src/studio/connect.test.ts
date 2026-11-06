import cytoscape from 'cytoscape'
import { describe, expect, it } from 'vitest'
import { applyEdges, connectionsOf, edgeElement, redrawOf, toConnect, waitsToConnect } from './connect'
import type { Connected } from './connect'
import type { CypherGraph, CypherResult } from './database'
import { graphOf, withConnections } from './results'

const cypher: CypherGraph = {
  nodes: [
    { id: 'a', labels: ['Person'], properties: { name: 'Ada' } },
    { id: 'b', labels: ['Person'], properties: { name: 'Bea' } },
    { id: 'c', labels: ['Movie'], properties: { title: 'Cleo' } },
  ],
  relationships: [{ id: 'r0', type: 'KNOWS', from: 'a', to: 'b', properties: {} }],
}
const connecting = [
  { id: 'r0', type: 'KNOWS', from: 'a', to: 'b', properties: {} },
  { id: 'r1', type: 'ACTED_IN', from: 'a', to: 'c', properties: {} },
  { id: 'r2', type: 'ACTED_IN', from: 'b', to: 'c', properties: {} },
  // To a node not in the result: left out.
  { id: 'r3', type: 'ACTED_IN', from: 'b', to: 'z', properties: {} },
]
const result = { graph: cypher } as CypherResult
const connected = (over: Partial<Connected> = {}): Connected => ({ for: result, connection: 'one', relationships: connecting, truncated: false, ...over })

describe('withConnections', () => {
  it('keeps the nodes, their array and the labels of what the query gave back, and adds the rest marked', () => {
    const base = graphOf(cypher)
    const joined = withConnections(base, cypher, connecting)
    expect(joined.graph.nodes).toBe(base.graph.nodes)
    expect(joined.labels).toBe(base.labels)
    expect(joined.graph.edges.slice(0, 1)).toEqual(base.graph.edges)
    expect(joined.graph.edges.slice(1).map(e => [e.id, e.added])).toEqual([['relationship:r1', true], ['relationship:r2', true]])
    // As graphOf gives them, with the connections given to it.
    expect(graphOf(cypher, connecting).graph.edges).toEqual(joined.graph.edges)
  })
})

describe('reading the connections', () => {
  it('reads them once for a result and connection, when they are wanted', () => {
    expect(toConnect(true, result, 'one', null)).toBe(true)
    expect(toConnect(true, result, 'one', connected())).toBe(false)
    expect(toConnect(false, result, 'one', null)).toBe(false)
    expect(toConnect(true, null, 'one', null)).toBe(false)
    expect(toConnect(true, result, undefined, null)).toBe(false)
  })

  it('reads them again for a new result, or on another connection', () => {
    const next = { graph: cypher } as CypherResult
    expect(toConnect(true, next, 'one', connected())).toBe(true)
    expect(toConnect(true, result, 'two', connected())).toBe(true)
    expect(connectionsOf(connected(), next, 'one')).toBeUndefined()
    expect(connectionsOf(connected(), result, 'one')?.relationships).toBe(connecting)
  })

  it('holds back only a new result run with them on, until they are read', () => {
    expect(waitsToConnect(true, result, 'one', result, null)).toBe(true)
    expect(waitsToConnect(true, result, 'one', result, connected())).toBe(false)
    // Turned on for a result drawn already: it stays drawn, and they are added when they come.
    expect(waitsToConnect(true, result, 'one', null, null)).toBe(false)
    expect(waitsToConnect(false, result, 'one', result, null)).toBe(false)
  })
})

describe('redrawOf', () => {
  const fragments = ['Movie', 'Person']
  const base = graphOf(cypher)
  const joined = withConnections(base, cypher, connecting)

  it('lays out a graph drawn first, or one of other nodes or colours', () => {
    expect(redrawOf(null, { graph: base.graph, fragments })).toEqual({ kind: 'layout' })
    expect(redrawOf({ graph: base.graph, fragments }, { graph: graphOf(cypher).graph, fragments })).toEqual({ kind: 'layout' })
    expect(redrawOf({ graph: base.graph, fragments }, { graph: joined.graph, fragments: [...fragments] })).toEqual({ kind: 'layout' })
  })

  it('adds the connections to the same nodes, and takes them away again, and nothing else', () => {
    const on = redrawOf({ graph: base.graph, fragments }, { graph: joined.graph, fragments })
    expect(on).toEqual({ kind: 'edges', add: joined.graph.edges.slice(1), remove: [] })
    const off = redrawOf({ graph: joined.graph, fragments }, { graph: base.graph, fragments })
    expect(off).toEqual({ kind: 'edges', add: [], remove: ['relationship:r1', 'relationship:r2'] })
    expect(redrawOf({ graph: base.graph, fragments }, { graph: base.graph, fragments })).toEqual({ kind: 'edges', add: [], remove: [] })
  })

  it('lays the same nodes out again while their first layout is still arranging', () => {
    expect(redrawOf({ graph: base.graph, fragments }, { graph: joined.graph, fragments }, true)).toEqual({ kind: 'layout' })
  })
})

describe('a toggle on the 2D core', () => {
  const fragments = ['Movie', 'Person']
  const base = graphOf(cypher)
  const joined = withConnections(base, cypher, connecting)
  const drawnCore = () => {
    const core = cytoscape({ headless: true, styleEnabled: true })
    core.add([...base.graph.nodes.map(n => ({ group: 'nodes' as const, data: { id: n.id, node: n } })), ...base.graph.edges.map(edgeElement)])
    core.nodes().forEach((node, i) => { node.position({ x: 100 * i + 7, y: 50 * i - 3 }) })
    core.getElementById('node:a').select()
    return core
  }
  const places = (core: cytoscape.Core) => core.nodes().map(n => ({ id: n.id(), ...n.position() }))

  it('adds the connecting relationships, marked, and takes them away, leaving every node where it was', () => {
    const core = drawnCore()
    const before = places(core)
    const on = redrawOf({ graph: base.graph, fragments }, { graph: joined.graph, fragments })
    if (on.kind !== 'edges') throw new Error('expected an edges redraw')
    applyEdges(core, on)
    expect(core.edges().map(e => [e.id(), e.data('added')])).toEqual([['relationship:r0', false], ['relationship:r1', true], ['relationship:r2', true]])
    expect(places(core)).toEqual(before)
    expect(core.getElementById('node:a').selected()).toBe(true)

    const off = redrawOf({ graph: joined.graph, fragments }, { graph: base.graph, fragments })
    if (off.kind !== 'edges') throw new Error('expected an edges redraw')
    applyEdges(core, off)
    expect(core.edges().map(e => e.id())).toEqual(['relationship:r0'])
    expect(places(core)).toEqual(before)
    expect(core.getElementById('node:a').selected()).toBe(true)
    core.destroy()
  })

  it('leaves out a relationship to a node it does not draw', () => {
    const core = drawnCore()
    applyEdges(core, { kind: 'edges', add: [{ id: 'relationship:x', from: 'node:a', to: 'node:z', type: 'T', directed: true, properties: {} }], remove: [] })
    expect(core.edges().map(e => e.id())).toEqual(['relationship:r0'])
    core.destroy()
  })
})
