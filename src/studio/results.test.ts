import { describe, expect, it } from 'vitest'
import type { CypherNode } from './database'
import { cellText, graphOf, NO_LABEL, parametersOf } from './results'

const ada: CypherNode = { id: 'n0', labels: ['Person', 'Author'], properties: { name: 'Ada' } }
const bare: CypherNode = { id: 'n1', labels: [], properties: { born: 1815 } }

describe('graphOf', () => {
  it('colours each node by its first label, and lists the labels sorted', () => {
    const { graph, labels } = graphOf({
      nodes: [ada, bare],
      relationships: [{ id: 'r0', type: 'KNOWS', from: 'n0', to: 'n1', properties: {} }],
    })
    expect(graph.nodes.map(n => n.fragment)).toEqual(['Person', NO_LABEL])
    expect(labels).toEqual([NO_LABEL, 'Person'].sort((a, b) => a.localeCompare(b)))
    expect(graph.edges).toEqual([{ id: 'r0', from: 'n0', to: 'n1', type: 'KNOWS', directed: true, properties: {} }])
    expect(graph.roots).toEqual([])
  })
})

describe('cellText', () => {
  it('writes a node as its labels and caption, or its id when it has neither', () => {
    expect(cellText({ kind: 'node', node: ada })).toBe('(:Person:Author Ada)')
    expect(cellText({ kind: 'node', node: { id: 'n9', labels: [], properties: {} } })).toBe('(n9)')
  })

  it('writes a path by its ends and its length', () => {
    expect(cellText({ kind: 'path', nodes: [ada, bare], relationships: [{ id: 'r', type: 'T', from: 'n0', to: 'n1', properties: {} }] }))
      .toBe('(:Person:Author Ada) → 1 hop → (n1)')
  })

  it('writes lists, maps, nulls and values', () => {
    expect(cellText({
      kind: 'map',
      entries: [
        { key: 'xs', value: { kind: 'list', items: [{ kind: 'value', value: 1 }, { kind: 'null' }] } },
        { key: 'big', value: { kind: 'value', value: '9007199254740993', type: 'int' } },
      ],
    })).toBe('{xs: [1, null], big: 9007199254740993}')
    expect(cellText({ kind: 'relationship', relationship: { id: 'r', type: 'KNOWS', from: 'a', to: 'b', properties: {} } })).toBe('[:KNOWS]')
  })
})

describe('parametersOf', () => {
  it('takes nothing for none, and a JSON object for some', () => {
    expect(parametersOf('  ')).toEqual({ parameters: {} })
    expect(parametersOf('{"born": 1815}')).toEqual({ parameters: { born: 1815 } })
  })

  it('says what is wrong with anything else', () => {
    expect(parametersOf('{born: 1815}')).toMatchObject({ problem: expect.stringContaining('not JSON') })
    expect(parametersOf('[1]')).toMatchObject({ problem: expect.stringContaining('a JSON object') })
    expect(parametersOf('null')).toMatchObject({ problem: expect.stringContaining('a JSON object') })
  })
})
