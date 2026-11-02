import { describe, expect, it } from 'vitest'
import type { GraphNode } from './api'
import { captionOf, colourOf, iconLabelOf, pack } from './GraphView'

const node = (properties: Record<string, unknown>): GraphNode =>
  ({ id: '1', fragment: 'Person', labels: ['Person'], properties, aggregates: {} })

describe('captionOf', () => {
  it('prefers the name, then the title, to any other text', () => {
    expect(captionOf(node({ bio: 'Leads', title: 'Dr', name: 'Ada' }))).toBe('Ada')
    expect(captionOf(node({ bio: 'Leads', title: 'Dr' }))).toBe('Dr')
  })

  it('falls back to the first text that is not empty or an id', () => {
    expect(captionOf(node({ uuid: '123e4567-e89b-12d3-a456-426614174000', name: '', age: 36, bio: 'Leads' }))).toBe('Leads')
  })

  it('falls back to the fragment when the node has no text', () => {
    expect(captionOf(node({ uuid: '123e4567-e89b-12d3-a456-426614174000', age: 36 }))).toBe('Person')
  })
})

describe('colourOf', () => {
  it('gives each fragment its own colour by its place in the catalogue, wrapping past the palette', () => {
    const fragments = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']
    expect(colourOf(fragments, 'A')).not.toEqual(colourOf(fragments, 'B'))
    expect(colourOf(fragments, 'I')).toEqual(colourOf(fragments, 'A'))
  })

  it('gives a fragment missing from the catalogue the first colour rather than none', () => {
    expect(colourOf(['A'], 'Z')).toEqual(colourOf(['A'], 'A'))
  })
})

describe('iconLabelOf', () => {
  it("takes a fragment's nodes' first label, and none for nodes with no label, as its nodes have no icon", () => {
    const nodes = [node({}), { ...node({}), fragment: 'No label', labels: [] }]
    expect(iconLabelOf(nodes, 'Person')).toBe('Person')
    expect(iconLabelOf(nodes, 'No label')).toBeUndefined()
  })
})

describe('pack', () => {
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  it('sets two parts side by side in a wide window, the gap between them', () => {
    const places = pack([{ width: 400, height: 300 }, { width: 150, height: 120 }], 2, 60)
    expect(places[0]!.y).toBe(0)
    expect(places[1]!.x).toBe(places[0]!.x + 400 + 60)
    // The smaller is centred on the larger's middle.
    expect(places[1]!.y).toBe(90)
  })

  it('stacks them in a tall one', () => {
    const places = pack([{ width: 400, height: 300 }, { width: 400, height: 300 }], 0.5, 60)
    expect(places[0]!.x).toBe(places[1]!.x)
    expect(places[1]!.y).toBe(360)
  })

  it('never draws one part over another, however many there are', () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({ width: 20 + ((i * 37) % 200), height: 20 + ((i * 53) % 150) }))
    const placed = pack(parts, 1.6, 10).map((p, i) => ({ ...p, ...parts[i]! }))
    for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) expect(overlap(a, b)).toBe(false)
  })

  it('places nothing for no parts, and one part in the top row', () => {
    expect(pack([], 1, 10)).toEqual([])
    const [one] = pack([{ width: 50, height: 50 }], 1, 10)
    expect(one!.y).toBe(0)
    expect(one!.x).toBeGreaterThanOrEqual(0)
  })
})
