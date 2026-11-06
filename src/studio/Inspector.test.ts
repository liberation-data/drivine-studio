import { describe, expect, it } from 'vitest'
import { kindOf } from './Inspector'

describe('kindOf', () => {
  it("says a Cypher node's labels once: its fragment is only its first label", () => {
    expect(kindOf({ fragment: 'ContainerSection', labels: ['ContainerSection', 'ContentElement'] })).toBe(':ContainerSection:ContentElement')
  })

  it('names the fragment a node was loaded as, before its labels', () => {
    expect(kindOf({ fragment: 'Author', labels: ['Person', 'GithubPerson'] })).toBe('Author :Person:GithubPerson')
  })

  it('names the fragment alone when the node has no labels', () => {
    expect(kindOf({ fragment: 'No label', labels: [] })).toBe('No label')
  })
})
