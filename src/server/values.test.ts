import neo4j from 'neo4j-driver'
import { describe, expect, it } from 'vitest'
import { Cells, plain } from './values'

const { Node, Relationship, Path, PathSegment } = neo4j.types
const ada = new Node(neo4j.int(0), ['Person'], { name: 'Ada', born: neo4j.int(1815) }, 'n0')
const charles = new Node(neo4j.int(1), ['Person'], { name: 'Charles' }, 'n1')
const knows = new Relationship(neo4j.int(0), neo4j.int(0), neo4j.int(1), 'KNOWS', { since: neo4j.int(1833) }, 'r0', 'n0', 'n1')

describe('Cells over Bolt', () => {
  it('keeps a node\'s id and labels, and its properties as plain values', () => {
    expect(new Cells('bolt').cell(ada)).toEqual({ kind: 'node', node: { id: 'n0', labels: ['Person'], properties: { name: 'Ada', born: 1815 } } })
  })

  it('gathers each node and relationship once, from wherever in the rows it was', () => {
    const cells = new Cells('bolt')
    const path = new Path(ada, charles, [new PathSegment(ada, knows, charles)])
    expect(cells.cell(path)).toMatchObject({ kind: 'path', nodes: [{ id: 'n0' }, { id: 'n1' }], relationships: [{ id: 'r0', from: 'n0', to: 'n1' }] })
    cells.cell([ada, { who: charles }])
    const graph = cells.graph()
    expect(graph.nodes.map(n => n.id)).toEqual(['n0', 'n1'])
    expect(graph.relationships).toEqual([{ id: 'r0', type: 'KNOWS', from: 'n0', to: 'n1', properties: { since: 1833 } }])
  })

  it('stands in for a relationship\'s end it did not give back, until the node itself comes', () => {
    const cells = new Cells('bolt')
    cells.cell(knows)
    expect(cells.graph().nodes).toEqual([
      { id: 'n0', labels: [], properties: {}, partial: true },
      { id: 'n1', labels: [], properties: {}, partial: true },
    ])
    cells.cell(ada)
    expect(cells.graph().nodes[0]).toEqual({ id: 'n0', labels: ['Person'], properties: { name: 'Ada', born: 1815 } })
  })

  it('keeps a whole number too large for JavaScript exact, as its digits', () => {
    expect(new Cells('bolt').cell(neo4j.int('9007199254740993'))).toEqual({ kind: 'value', value: '9007199254740993', type: 'int' })
    expect(plain({ big: neo4j.int('9007199254740993') })).toEqual({ big: '9007199254740993' })
  })

  it('shows a temporal value or a point as its text, saying what it is', () => {
    expect(new Cells('bolt').cell(new neo4j.types.Date(2020, 1, 2))).toEqual({ kind: 'value', value: '2020-01-02', type: 'date' })
    expect(new Cells('bolt').cell(new neo4j.types.Duration(1, 2, 3, 0))).toMatchObject({ kind: 'value', type: 'duration' })
    expect(new Cells('bolt').cell(new neo4j.types.Point(7203, 1, 2))).toMatchObject({ kind: 'value', type: 'point' })
  })

  it('shows bytes, as Bolt gives them, by how many there are', () => {
    expect(new Cells('bolt').cell(new Int8Array([1, 2, 3]))).toEqual({ kind: 'value', value: '3 bytes', type: 'bytes' })
    expect(plain({ photo: new Int8Array([1, 2]) })).toEqual({ photo: '2 bytes' })
  })

  it('gives lists and maps cell by cell, and null as null', () => {
    expect(new Cells('bolt').cell({ xs: [1, null], ok: true })).toEqual({
      kind: 'map',
      entries: [
        { key: 'xs', value: { kind: 'list', items: [{ kind: 'value', value: 1 }, { kind: 'null' }] } },
        { key: 'ok', value: { kind: 'value', value: true } },
      ],
    })
  })
})

describe('Cells over FalkorDB', () => {
  const node = { id: 3, labels: ['Person'], properties: { name: 'Ada' } }
  const edge = { id: 9, relationshipType: 'KNOWS', sourceId: 3, destinationId: 4, properties: {} }

  it('reads FalkorDB\'s nodes, edges and paths by their shapes', () => {
    const cells = new Cells('falkordb')
    expect(cells.cell(node)).toEqual({ kind: 'node', node: { id: '3', labels: ['Person'], properties: { name: 'Ada' } } })
    expect(cells.cell(edge)).toEqual({ kind: 'relationship', relationship: { id: '9', type: 'KNOWS', from: '3', to: '4', properties: {} } })
    expect(cells.cell({ nodes: [node], edges: [edge] })).toMatchObject({ kind: 'path', nodes: [{ id: '3' }], relationships: [{ id: '9' }] })
    expect(cells.graph().nodes.map(n => [n.id, n.partial ?? false])).toEqual([['3', false], ['4', true]])
  })

  it('takes a map that only looks a little like a node for a map', () => {
    expect(new Cells('falkordb').cell({ labels: ['x'] })).toMatchObject({ kind: 'map' })
  })
})
