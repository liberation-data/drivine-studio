import { CompletionContext } from '@codemirror/autocomplete'
import { StringStream } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { cypherTokens, fromSchema, runCommand } from './CypherEditor'

// Each token the editor draws, and how, line by line as CodeMirror reads them: spaces left out.
const tokens = (text: string): [string, string][] => {
  const state = cypherTokens.startState!(2)
  const out: [string, string][] = []
  for (const line of text.split('\n')) {
    const stream = new StringStream(line, 2, 2)
    while (!stream.eol()) {
      stream.start = stream.pos
      const style = cypherTokens.token(stream, state)
      if (style) out.push([stream.current(), style])
    }
  }
  return out
}
const styleOf = (text: string, token: string) => tokens(text).find(([t]) => t === token)?.[1]

describe('the Cypher tokens', () => {
  it('draws keywords, labels, types, property keys, functions and parameters', () => {
    expect(tokens('MATCH (p:Person)-[:ACTED_IN]->(m) WHERE p.born > $year RETURN count(m)').filter(([, s]) => s !== 'bracket' && s !== 'operator' && s !== 'punctuation')).toEqual([
      ['MATCH', 'keyword'], ['p', 'variableName'], ['Person', 'typeName'], ['ACTED_IN', 'typeName'], ['m', 'variableName'],
      ['WHERE', 'keyword'], ['p', 'variableName'], ['born', 'propertyName'], ['$year', 'special'], ['RETURN', 'keyword'],
      ['count', 'function'], ['m', 'variableName'],
    ])
  })

  it('reads a backtick-quoted name whole, as what the colon or dot before it makes it', () => {
    expect(styleOf('MATCH (n:`Two words`)', '`Two words`')).toBe('typeName')
    expect(styleOf('RETURN n.`odd key`', '`odd key`')).toBe('propertyName')
    expect(styleOf('MATCH (n {`odd key`: 1})', '`odd key`')).toBe('propertyName')
  })

  it('reads a string whole, past the quotes it escapes', () => {
    expect(tokens("RETURN 'it\\'s', \"a \\\"b\\\"\", 'c\\\\'")).toEqual([
      ['RETURN', 'keyword'], ["'it\\'s'", 'string'], [',', 'punctuation'], ['"a \\"b\\""', 'string'], [',', 'punctuation'], ["'c\\\\'", 'string'],
    ])
  })

  it('reads comments, a block one across lines', () => {
    expect(tokens('RETURN 1 // p:Person')).toEqual([['RETURN', 'keyword'], ['1', 'number'], ['// p:Person', 'comment']])
    expect(tokens('/* a\nMATCH (n:X) */ RETURN n').map(([, s]) => s)).toEqual(['comment', 'comment', 'comment', 'keyword', 'variableName'])
  })

  it('draws a map’s key as a key, and a label in a subquery’s braces as a label', () => {
    expect(styleOf('CREATE (n {name: 1})', 'name')).toBe('propertyName')
    expect(styleOf('RETURN {name: x, born: 1}', 'born')).toBe('propertyName')
    expect(styleOf('MATCH (n) WHERE EXISTS { MATCH (n) WHERE n:Person }', 'Person')).toBe('typeName')
    expect(styleOf('CALL { MATCH (n) WHERE n:Person RETURN n }', 'n')).toBe('variableName')
  })

  it('draws each label or type after a bar or ampersand of them as one, and a number’s dot as part of it', () => {
    expect(tokens('MATCH ()-[:ACTED_IN|DIRECTED]->(n:Person&Actor)').filter(([, s]) => s === 'typeName')).toEqual([
      ['ACTED_IN', 'typeName'], ['DIRECTED', 'typeName'], ['Person', 'typeName'], ['Actor', 'typeName'],
    ])
    expect(styleOf('RETURN a | b', 'b')).toBe('variableName')
    expect(tokens('RETURN 1.5')).toEqual([['RETURN', 'keyword'], ['1.5', 'number']])
  })
})

describe('runCommand', () => {
  it('runs the text the editor holds, as changed in the same event, not as last drawn', () => {
    const drawn = EditorState.create({ doc: 'MATCH (n) RETURN n' })
    // A change read on the keydown itself, as at the end of a composition: React hasn't drawn it when ⌘↵ runs.
    const typed = drawn.update({ changes: { from: drawn.doc.length, insert: ' LIMIT 5' } }).state
    const onRun = vi.fn()
    expect(runCommand(onRun)({ state: typed })).toBe(true)
    expect(onRun).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 5')
  })
})

describe('fromSchema', () => {
  const schema = { labels: ['Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['name'] }
  // What the editor offers with the cursor where the caret mark is, typed or asked for (Ctrl+Space).
  const offered = (text: string, explicit = false) => {
    const doc = text.replace('‸', '')
    return fromSchema(() => schema)(new CompletionContext(EditorState.create({ doc }), text.indexOf('‸'), explicit))
  }

  it('offers the graph’s names at once, after a colon or a dot', () => {
    expect(offered('MATCH (n:‸')).toMatchObject({ from: 9, options: [{ label: 'Person', apply: 'Person' }] })
    expect(offered('RETURN n.‸')?.options.map(o => o.label)).toEqual(['name'])
  })

  it('offers words of the language only once two letters are typed, or when asked for, and names a function as one', () => {
    expect(offered('M‸')).toBeNull()
    expect(offered('M‸', true)?.options.length).toBeGreaterThan(0)
    const words = offered('co‸')!.options
    expect(words.find(o => o.label === 'count')).toMatchObject({ detail: 'function' })
    expect(words.find(o => o.label === 'MATCH')?.detail).toBeUndefined()
  })

  it('offers nothing where nothing is expected, or the graph has no names of the kind', () => {
    expect(offered("RETURN 'n.‸")).toBeNull()
    expect(fromSchema(() => ({ labels: [], relationshipTypes: [], propertyKeys: [] }))(new CompletionContext(EditorState.create({ doc: 'MATCH (n:' }), 9, false))).toBeNull()
  })
})
