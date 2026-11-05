import { describe, expect, it } from 'vitest'
import { clip, edgeLit, fits3D, focusSetOf, hubOf, legendOf, litOf, MAX_3D_NODES, namePriority, overlaps, shownDepth, shownOf, toggled, uncrowded } from './graph3d'

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

describe('namePriority', () => {
  const ids = ['a', 'b', 'hub', 'c', 'd']
  const edges = [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c'), edge('c', 'd'), edge('b', 'c')]
  const none = { chosen: null, hovered: null, focus: null }

  it('gives hubs room first, then the rest in the graph order', () => {
    expect(namePriority(ids, edges, none)).toEqual(['hub', 'c', 'b', 'a', 'd'])
  })

  it('puts the node chosen first, then the one under the pointer, then the focus node and its neighbours', () => {
    expect(namePriority(ids, edges, { chosen: 'd', hovered: 'a', focus: 'd' })).toEqual(['d', 'a', 'c', 'hub', 'b'])
  })

  it('ranks the focus node’s neighbours above a bigger hub outside them', () => {
    expect(namePriority(ids, edges, { chosen: null, hovered: null, focus: 'a' }).slice(0, 2)).toEqual(['hub', 'a'])
    expect(namePriority(ids, edges, { chosen: null, hovered: null, focus: 'd' })).toEqual(['c', 'd', 'hub', 'b', 'a'])
  })
})

describe('uncrowded', () => {
  const box = (id: string, x: number, y: number, width = 40, height = 10) => ({ id, x, y, width, height })

  it('keeps names that do not touch', () => {
    expect(uncrowded([box('a', 0, 0), box('b', 100, 0), box('c', 0, 50)])).toEqual(new Set(['a', 'b', 'c']))
  })

  it('drops a name that would overlap one given room before it, and keeps the first', () => {
    expect(uncrowded([box('first', 0, 0), box('second', 20, 4), box('third', 200, 200)])).toEqual(new Set(['first', 'third']))
  })

  it('keeps a gap between names', () => {
    expect(uncrowded([box('a', 0, 0), box('b', 41, 0)], 0)).toEqual(new Set(['a', 'b']))
    expect(uncrowded([box('a', 0, 0), box('b', 41, 0)], 2)).toEqual(new Set(['a']))
  })

  it('finds an overlap across grid cells, and with a box wider than a cell', () => {
    expect(uncrowded([box('wide', 0, 0, 400), box('far end', 180, 3)], 2, 64)).toEqual(new Set(['wide']))
    expect(uncrowded([box('a', 63, 0), box('b', 66, 0)], 2, 64)).toEqual(new Set(['a']))
  })

  it('keeps a name off another node\u2019s shape, but not off its own', () => {
    const shape = (id: string, x: number, y: number) => ({ id, x, y, width: 20, height: 20, obstacle: true })
    expect(uncrowded([shape('a', 0, 0), box('a', 0, 12), shape('b', 0, 30), box('b', 0, 18)])).toEqual(new Set(['a']))
    expect(uncrowded([box('b', 0, 18), shape('a', 0, 0), shape('b', 0, 30)])).toEqual(new Set(['b']))
  })

  it('checks a dropped name against nothing: a name hidden takes no room', () => {
    expect(uncrowded([box('a', 0, 0), box('b', 35, 0), box('c', 70, 0)], 0)).toEqual(new Set(['a', 'c']))
  })
})

describe('overlaps', () => {
  it('is true when boxes share area and false when they only meet', () => {
    expect(overlaps({ id: 'a', x: 0, y: 0, width: 10, height: 10 }, { id: 'b', x: 5, y: 5, width: 10, height: 10 })).toBe(true)
    expect(overlaps({ id: 'a', x: 0, y: 0, width: 10, height: 10 }, { id: 'b', x: 10, y: 0, width: 10, height: 10 })).toBe(false)
  })
})
