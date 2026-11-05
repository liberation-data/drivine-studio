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
  | {
      kind: 'label' | 'relationshipType' | 'property' | 'word'
      from: number
      typed: string
      /** In a name in backticks: `from` is past the opening one, and the closing one is there already, or still to come. */
      backtick?: 'open' | 'closed'
    }
  | { kind: 'none' }

const WORD = /[A-Za-z0-9_]/

/** Braces after CALL, EXISTS, COUNT or COLLECT hold a subquery, read as a statement is, not a map: `text` is before them. */
export const opensSubquery = (text: string) => /\b(CALL|EXISTS|COUNT|COLLECT)\s*$/i.test(text)
/** What stands for a subquery's braces among the brackets open, so they aren't taken for a map's. */
export const SUBQUERY = 'subquery'

/**
 * What the cursor at `pos` in `text` is in, read from the start: inside a string or a comment there is nothing to
 * complete; after a colon in a node pattern a label, in a relationship's brackets a type; after a dot, or as a key in a
 * map, a property key; otherwise a keyword or a function.
 */
export function expecting(text: string, pos: number): Expecting {
  // The brackets open at the cursor, innermost last; and whether the cursor is in a string or a comment.
  const open: string[] = []
  // Where the cursor is in a name in backticks, the opening backtick's place.
  let quote: number | undefined
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
      if (end === -1 || end >= pos) {
        quote = i
        break
      }
      i = end + 1
      continue
    }
    if (c === '(') open.push(c)
    // A relationship's brackets follow its dash; a list's, as a comprehension's, hold labels after a colon, not types.
    else if (c === '[') open.push(wordBefore(text, i) === '-' ? c : 'list')
    else if (c === '{') open.push(opensSubquery(wordBefore(text, i)) ? SUBQUERY : c)
    else if (c === ')' || c === ']' || c === '}') open.pop()
    i++
  }
  let from = pos
  if (quote !== undefined) from = quote + 1
  else while (from > 0 && WORD.test(text[from - 1]!)) from--
  const typed = text.slice(from, pos)
  const name = (kind: 'label' | 'relationshipType' | 'property'): Expecting =>
    quote === undefined ? { kind, from, typed } : { kind, from, typed, backtick: text[pos] === '`' ? 'closed' : 'open' }
  let before = (quote ?? from) - 1
  // Back past spaces and line breaks: a map's keys, a statement's clauses, are often a line each.
  while (before >= 0 && /\s/.test(text[before]!)) before--
  const mark = text[before]
  const inner = open[open.length - 1]
  if (mark === ':' || ((mark === '|' || mark === '&') && labelChain(text, before))) {
    // `{name: …}` is a value, not a label.
    if (inner === '{') return { kind: 'none' }
    return name(inner === '[' ? 'relationshipType' : 'label')
  }
  // After a variable's dot, or the dot after what a call or an index gives, `head(…).title`; not a number's: `1.5`, or a
  // range's `*1..3`.
  if (mark === '.' && before > 0 && /[A-Za-z0-9_)\]]/.test(text[before - 1]!) && !/(^|[^A-Za-z0-9_])[0-9]+$/.test(text.slice(0, before))) {
    return name('property')
  }
  if (inner === '{' && (mark === '{' || mark === ',')) return name('property')
  // A number is being typed, or nothing yet in the middle of a line, or a name in backticks no word of the language is:
  // no list to put in the way. A parameter's name, after its `$`, is the user's own, too.
  if (typed === '' || /^[0-9]/.test(typed) || quote !== undefined || text[from - 1] === '$') return { kind: 'none' }
  return { kind: 'word', from, typed }
}

// The word before `at`, back past spaces, or the one mark there if it isn't a word: read back from `at`, so a long
// statement, as a pasted list of rows, isn't read again from its start at each of its brackets.
function wordBefore(text: string, at: number): string {
  let end = at
  while (end > 0 && /\s/.test(text[end - 1]!)) end--
  let start = end
  while (start > 0 && WORD.test(text[start - 1]!)) start--
  return text.slice(start === end ? Math.max(0, end - 1) : start, end)
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
  // In backticks already, a name is put in as it is in them, and closed if it isn't yet.
  const backtick = expected.kind === 'none' ? undefined : expected.backtick
  const apply = (name: string) => (backtick ? name.replace(/`/g, '``') + (backtick === 'open' ? '`' : '') : quoted(name))
  switch (expected.kind) {
    case 'label':
      return schema.labels.map(name => ({ label: name, type: 'type', apply: apply(name) }))
    case 'relationshipType':
      return schema.relationshipTypes.map(name => ({ label: name, type: 'type', apply: apply(name) }))
    case 'property':
      return schema.propertyKeys.map(name => ({ label: name, type: 'property', apply: apply(name) }))
    case 'word':
      return [
        ...KEYWORDS.map(word => ({ label: word, type: 'keyword', apply: word })),
        ...FUNCTIONS.map(name => ({ label: name, type: 'function', apply: name })),
      ]
    default:
      return []
  }
}
