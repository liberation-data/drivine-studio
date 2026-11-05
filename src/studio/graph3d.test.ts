import { describe, expect, it } from 'vitest'
import { clip, edgeLit, fits3D, focusSetOf, hubOf, legendOf, litOf, MAX_3D_NODES, shownDepth, shownOf, toggled } from './graph3d'

const node = (id: string, fragment = 'Person') => ({ id, fragment })
const edge = (from: string, to: string) => ({ from, to })

describe('the size 3D is offered for', () => {
  it('draws up to the limit, and no more', () => {
    expect(fits3D(MAX_3D_NODES)).toBe(true)
    expect(fits3D(MAX_3D_NODES + 1)).toBe(false)
  })

  it('falls back to 2D for a bigger graph, and back to 3D for the next small one', () => {
    expect(shownDepth('3d', 50)).toBe('3d')
    expect(shownDepth('3d', 5000)).toBe('2d')
    expect(shownDepth('2d', 50)).toBe('2d')
  })
})

describe('hubOf', () => {
  it('opens on the node with most relationships', () => {
    expect(hubOf([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('c', 'b'), edge('b', 'b')])).toBe('b')
  })

  it('takes the first of equals, and any node of a graph with no relationships', () => {
    expect(hubOf([node('a'), node('b')], [edge('a', 'b')])).toBe('a')
    expect(hubOf([node('x')], [])).toBe('x')
    expect(hubOf([], [])).toBeUndefined()
  })
})

describe('focus', () => {
  const edges = [edge('a', 'b'), edge('c', 'a'), edge('c', 'd')]

  it('keeps a node and its neighbours, either way round', () => {
    expect([...focusSetOf('a', edges)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps everything solid with nothing in focus and nothing hidden', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(id => node(id))
    expect(litOf(nodes, edges, null, new Set()).size).toBe(4)
    expect([...litOf(nodes, edges, 'd', new Set())].sort()).toEqual(['c', 'd'])
  })

  it('lights a relationship only when both its ends are', () => {
    const lit = new Set(['a', 'b'])
    expect(edgeLit(edge('a', 'b'), lit)).toBe(true)
    expect(edgeLit(edge('a', 'c'), lit)).toBe(false)
  })
})

describe('the legend', () => {
  const nodes = [node('1', 'Repo'), node('2', 'Person'), node('3', 'Person'), node('4', 'Loose')]

  it('lists the fragments present, in the catalogue order, with their counts', () => {
    expect(legendOf(nodes, ['Person', 'Issue', 'Repo'])).toEqual([
      { fragment: 'Person', count: 2 },
      { fragment: 'Repo', count: 1 },
      { fragment: 'Loose', count: 1 },
    ])
  })

  it('fades the nodes of a fragment unchecked, as well as those out of focus', () => {
    const hidden = new Set(['Person'])
    expect([...litOf(nodes, [], null, hidden)].sort()).toEqual(['1', '4'])
    expect([...litOf(nodes, [edge('1', '2')], '1', hidden)]).toEqual(['1'])
  })

  it('says whether all, none or some are shown', () => {
    const entries = legendOf(nodes, [])
    expect(shownOf(entries, new Set())).toBe('all')
    expect(shownOf(entries, new Set(['Person']))).toBe('some')
    expect(shownOf(entries, new Set(['Person', 'Repo', 'Loose']))).toBe('none')
  })

  it('checks and unchecks one fragment without changing the set it was given', () => {
    const hidden = new Set(['Repo'])
    expect([...toggled(hidden, 'Person', false)].sort()).toEqual(['Person', 'Repo'])
    expect([...toggled(hidden, 'Repo', true)]).toEqual([])
    expect([...hidden]).toEqual(['Repo'])
  })
})

describe('clip', () => {
  it('shortens a long caption with an ellipsis', () => {
    expect(clip('Ada')).toBe('Ada')
    expect(clip('a very long name for one node indeed', 10)).toBe('a very lo…')
  })
})
