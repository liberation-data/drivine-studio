import { describe, expect, it } from 'vitest'
import type { GraphNode } from './api'
import { captionOf, colourOf } from './GraphView'

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
