import { describe, expect, it } from 'vitest'
import { completionsFor, expecting, quoted } from './cypherSyntax'

// The cursor is where the caret mark is.
const at = (text: string) => expecting(text.replace('‸', ''), text.indexOf('‸'))

describe('expecting', () => {
  it('expects a label after a colon in a node pattern, and a type in a relationship', () => {
    expect(at('MATCH (p:Per‸')).toEqual({ kind: 'label', from: 9, typed: 'Per' })
    expect(at('MATCH (p:Person)-[:ACT‸')).toEqual({ kind: 'relationshipType', from: 19, typed: 'ACT' })
    expect(at('MATCH (p)-[r:‸]')).toEqual({ kind: 'relationshipType', from: 13, typed: '' })
    expect(at('MATCH (:‸')).toMatchObject({ kind: 'label', typed: '' })
  })

  it('expects a label in a WHERE, and after a bar or ampersand of labels', () => {
    expect(at('MATCH (n) WHERE n:Mov‸')).toMatchObject({ kind: 'label', typed: 'Mov' })
    expect(at('MATCH ()-[:ACTED_IN|DIR‸]->()')).toMatchObject({ kind: 'relationshipType', typed: 'DIR' })
    expect(at('MATCH (n:Person&Act‸')).toMatchObject({ kind: 'label', typed: 'Act' })
  })

  it('expects a property key after a dot, and as a key in a map, but not as a value', () => {
    expect(at('MATCH (p) RETURN p.‸')).toEqual({ kind: 'property', from: 19, typed: '' })
    expect(at('MATCH (p) RETURN p.na‸')).toMatchObject({ kind: 'property', typed: 'na' })
    expect(at('MATCH (p:Person {na‸')).toMatchObject({ kind: 'property', typed: 'na' })
    expect(at("MATCH (p:Person {name: 'Keanu', bo‸")).toMatchObject({ kind: 'property', typed: 'bo' })
    expect(at('MATCH (p:Person {name: ‸')).toEqual({ kind: 'none' })
    expect(at('MATCH (p:Person {name: Ke‸')).toEqual({ kind: 'none' })
  })

  it('offers nothing in a string or a comment, nor for a number', () => {
    expect(at("MATCH (p {name: 'a:b‸")).toEqual({ kind: 'none' })
    expect(at('MATCH (p) // p.na‸')).toEqual({ kind: 'none' })
    expect(at('MATCH (p) /* p:‸ */')).toEqual({ kind: 'none' })
    expect(at('RETURN 12‸')).toEqual({ kind: 'none' })
  })

  it('reads past strings and comments that end before the cursor', () => {
    expect(at("MATCH (p {name: ')'}) /* ( */ RETURN p.‸")).toMatchObject({ kind: 'property' })
    expect(at('// (\nMATCH (n:‸')).toMatchObject({ kind: 'label' })
  })

  it('expects a word of the language otherwise', () => {
    expect(at('MAT‸')).toEqual({ kind: 'word', from: 0, typed: 'MAT' })
    expect(at('MATCH (n) RET‸')).toMatchObject({ kind: 'word', typed: 'RET' })
    expect(at('MATCH (n) ‸')).toEqual({ kind: 'none' })
  })
})

describe('completionsFor', () => {
  const schema = { labels: ['Movie', 'Person', 'Two words'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['born', 'name'] }

  it('offers the graph’s names for each kind, quoting one Cypher must', () => {
    expect(completionsFor({ kind: 'label', from: 0, typed: '' }, schema).map(o => o.apply)).toEqual(['Movie', 'Person', '`Two words`'])
    expect(completionsFor({ kind: 'relationshipType', from: 0, typed: '' }, schema).map(o => o.label)).toEqual(['ACTED_IN'])
    expect(completionsFor({ kind: 'property', from: 0, typed: '' }, schema).map(o => o.label)).toEqual(['born', 'name'])
  })

  it('offers keywords and functions for a word, and nothing for none', () => {
    const words = completionsFor({ kind: 'word', from: 0, typed: 'MA' }, schema).map(o => o.label)
    expect(words).toContain('MATCH')
    expect(words).toContain('collect')
    expect(completionsFor({ kind: 'none' }, schema)).toEqual([])
  })
})

describe('quoted', () => {
  it('backticks a name only where Cypher needs it, doubling a backtick in it', () => {
    expect(quoted('Person')).toBe('Person')
    expect(quoted('two words')).toBe('`two words`')
    expect(quoted('a`b')).toBe('`a``b`')
    expect(quoted('1st')).toBe('`1st`')
  })
})
