// Cypher, as the editor reads it: words to highlight, and what may be typed where, for completion. A reading of the
// text around the cursor, not a parser: it never says a statement is wrong, since what Drivine compiles to SQL is a
// subset of Cypher, and a squiggle the studio can't stand behind would be worse than none.

import type { GraphSchema } from './schema'

export const KEYWORDS = [
  'ALL', 'AND', 'ANY', 'AS', 'ASC', 'ASCENDING', 'BY', 'CALL', 'CASE', 'CONTAINS', 'CREATE', 'DELETE', 'DESC', 'DESCENDING',
  'DETACH', 'DISTINCT', 'ELSE', 'END', 'ENDS', 'EXISTS', 'FOREACH', 'IN', 'IS', 'LIMIT', 'MATCH', 'MERGE', 'NONE', 'NOT',
  'ON', 'OPTIONAL', 'OR', 'ORDER', 'REMOVE', 'RETURN', 'SET', 'SINGLE', 'SKIP', 'STARTS', 'THEN', 'UNION', 'UNWIND',
  'WHEN', 'WHERE', 'WITH', 'XOR', 'YIELD',
] as const

/** Words that are values, drawn as numbers are. */
export const ATOMS = ['true', 'false', 'null'] as const

export const FUNCTIONS = [
  'abs', 'avg', 'ceil', 'coalesce', 'collect', 'count', 'date', 'datetime', 'duration', 'elementId', 'endNode', 'exists',
  'floor', 'head', 'id', 'keys', 'labels', 'last', 'left', 'length', 'localdatetime', 'localtime', 'lower', 'ltrim',
  'max', 'min', 'nodes', 'percentileCont', 'percentileDisc', 'properties', 'rand', 'range', 'reduce', 'relationships',
  'replace', 'reverse', 'right', 'round', 'rtrim', 'shortestPath', 'allShortestPaths', 'sign', 'size', 'split', 'sqrt',
  'startNode', 'stDev', 'substring', 'sum', 'tail', 'time', 'toBoolean', 'toFloat', 'toInteger', 'toLower', 'toString',
  'toUpper', 'trim', 'type', 'upper',
] as const

const KEYWORD_SET = new Set<string>(KEYWORDS)
const ATOM_SET = new Set<string>(ATOMS)

export const isKeyword = (word: string) => KEYWORD_SET.has(word.toUpperCase())
export const isAtom = (word: string) => ATOM_SET.has(word.toLowerCase())

/** What may be typed at the cursor: a label, a relationship type, a property key, a word of the language, or nothing. */
export type Expecting =
  | { kind: 'label' | 'relationshipType' | 'property' | 'word'; from: number; typed: string }
  | { kind: 'none' }

const WORD = /[A-Za-z0-9_]/

/**
 * What the cursor at `pos` in `text` is in, read from the start: inside a string or a comment there is nothing to
 * complete; after a colon in a node pattern a label, in a relationship's brackets a type; after a dot, or as a key in a
 * map, a property key; otherwise a keyword or a function.
 */
export function expecting(text: string, pos: number): Expecting {
  // The brackets open at the cursor, innermost last; and whether the cursor is in a string or a comment.
  const open: string[] = []
  let i = 0
  while (i < pos) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      if (end === -1 || end >= pos) return { kind: 'none' }
      i = end + 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1 || end + 2 > pos) return { kind: 'none' }
      i = end + 2
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      if (j >= pos) return { kind: 'none' }
      i = j + 1
      continue
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      // A name in backticks is being typed: its kind is the one before the backtick, read below.
      if (end === -1 || end >= pos) break
      i = end + 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') open.push(c)
    else if (c === ')' || c === ']' || c === '}') open.pop()
    i++
  }
  let from = pos
  while (from > 0 && WORD.test(text[from - 1]!)) from--
  const typed = text.slice(from, pos)
  let before = from - 1
  if (text[before] === '`') before--
  while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before--
  const mark = text[before]
  const inner = open[open.length - 1]
  if (mark === ':' || ((mark === '|' || mark === '&') && labelChain(text, before))) {
    // `{name: …}` is a value, not a label.
    if (inner === '{') return { kind: 'none' }
    if (inner === '[') return { kind: 'relationshipType', from, typed }
    return { kind: 'label', from, typed }
  }
  if (mark === '.' && before > 0 && WORD.test(text[before - 1]!)) return { kind: 'property', from, typed }
  if (inner === '{' && (mark === '{' || mark === ',')) return { kind: 'property', from, typed }
  // A number is being typed, or nothing yet in the middle of a line: no list to put in the way.
  if (typed === '' || /^[0-9]/.test(typed)) return { kind: 'none' }
  return { kind: 'word', from, typed }
}

// `:A|B` or `:A&B`: the bar or ampersand follows a label or type, itself after a colon.
function labelChain(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && (WORD.test(text[i]!) || text[i] === '`')) i--
  return text[i] === ':' || ((text[i] === '|' || text[i] === '&') && labelChain(text, i))
}

/** A name as Cypher takes it after a colon or a dot: as it is where it can be, in backticks where it can't. */
export const quoted = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`')

/** The completions for what the cursor expects, from the connection's schema and the language's own words. */
export function completionsFor(expected: Expecting, schema: GraphSchema): { label: string; type: string; apply: string }[] {
  switch (expected.kind) {
    case 'label':
      return schema.labels.map(name => ({ label: name, type: 'type', apply: quoted(name) }))
    case 'relationshipType':
      return schema.relationshipTypes.map(name => ({ label: name, type: 'type', apply: quoted(name) }))
    case 'property':
      return schema.propertyKeys.map(name => ({ label: name, type: 'property', apply: quoted(name) }))
    case 'word':
      return [
        ...KEYWORDS.map(word => ({ label: word, type: 'keyword', apply: word })),
        ...FUNCTIONS.map(name => ({ label: name, type: 'function', apply: name })),
      ]
    default:
      return []
  }
}
