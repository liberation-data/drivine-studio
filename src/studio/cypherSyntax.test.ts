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

  it('expects a label, not a type, after a colon in a list, as a comprehension\'s WHERE', () => {
    expect(at('MATCH p = () RETURN [n IN nodes(p) WHERE n:Per‸')).toMatchObject({ kind: 'label', typed: 'Per' })
    expect(at('MATCH ()<-[:ACT‸')).toMatchObject({ kind: 'relationshipType', typed: 'ACT' })
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

  it('offers nothing in a parameter, nor after the dot of a number or a range', () => {
    expect(at('MATCH (p) WHERE p.name = $na‸')).toEqual({ kind: 'none' })
    expect(at('RETURN 1.‸')).toEqual({ kind: 'none' })
    expect(at('MATCH ()-[:KNOWS*1.‸')).toEqual({ kind: 'none' })
    expect(at('RETURN p1.na‸')).toMatchObject({ kind: 'property', typed: 'na' })
  })

  it('reads past strings and comments that end before the cursor', () => {
    expect(at("MATCH (p {name: ')'}) /* ( */ RETURN p.‸")).toMatchObject({ kind: 'property' })
    expect(at('// (\nMATCH (n:‸')).toMatchObject({ kind: 'label' })
  })

  it('reads a name in backticks whole, spaces and all, and says whether it is closed yet', () => {
    expect(at('MATCH (n:`Two wo‸')).toEqual({ kind: 'label', from: 10, typed: 'Two wo', backtick: 'open' })
    expect(at('MATCH (n:`Tw‸`)')).toEqual({ kind: 'label', from: 10, typed: 'Tw', backtick: 'closed' })
    expect(at('RETURN n.`odd‸')).toMatchObject({ kind: 'property', typed: 'odd', backtick: 'open' })
    expect(at('MATCH ()-[:`ACT‸')).toMatchObject({ kind: 'relationshipType', backtick: 'open' })
    expect(at('RETURN `x‸')).toEqual({ kind: 'none' })
  })

  it('reads a subquery’s braces as a statement, not a map', () => {
    expect(at('MATCH (n) WHERE EXISTS { MATCH (n) WHERE n:Mov‸')).toMatchObject({ kind: 'label', typed: 'Mov' })
    expect(at('CALL { MAT‸')).toMatchObject({ kind: 'word', typed: 'MAT' })
    expect(at('CALL { MATCH (n {na‸')).toMatchObject({ kind: 'property', typed: 'na' })
    expect(at('CALL { RETURN {name: ‸')).toEqual({ kind: 'none' })
  })

  it('reads a long statement, as a pasted list of rows, in time that grows with its length, not its square', () => {
    const statement = (count: number) => {
      const rows = Array.from({ length: count }, (_, i) => `{id: ${i}, name: 'Person ${i}', tags: ['a', 'b']}`).join(',\n')
      return `UNWIND [\n${rows}\n] AS row\nMERGE (p:Person {id: row.id}) SET p.`
    }
    // The best of a few, so a busy machine doesn't decide it: growth is measured, not a time, which a busy machine moves.
    const timed = (text: string) => {
      let best = Infinity
      for (let i = 0; i < 3; i++) {
        const started = performance.now()
        expect(expecting(text, text.length)).toMatchObject({ kind: 'property' })
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    const short = timed(statement(1000))
    // Eight times the rows, about 400 KB: about 8 times as long read once, about 64 times read again at each bracket.
    const long = timed(statement(8000))
    expect(long / Math.max(short, 0.05)).toBeLessThan(24)
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

  it('puts a name in as it goes in backticks already typed, closing them where they aren’t', () => {
    const odd = { ...schema, labels: ['Two words', 'a`b'] }
    expect(completionsFor({ kind: 'label', from: 0, typed: '', backtick: 'open' }, odd).map(o => o.apply)).toEqual(['Two words`', 'a``b`'])
    expect(completionsFor({ kind: 'label', from: 0, typed: '', backtick: 'closed' }, odd).map(o => o.apply)).toEqual(['Two words', 'a``b'])
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

// Movie-graph statements, with the cursor at each place that decides what kind of name is being typed.
describe('expecting, across movie-graph statements', () => {
  const cases: [string, string, string?][] = [
    // OPTIONAL MATCH
    ['OPTIONAL MATCH (p:Per‸', 'label', 'Per'],
    ['MATCH (p:Person) OPTIONAL MATCH (p)-[:DIR‸', 'relationshipType', 'DIR'],
    ['MATCH (p:Person) OPTIONAL MATCH (p)-[:DIRECTED]->(m:Mov‸', 'label', 'Mov'],
    ['OPTIONAL MAT‸', 'word', 'MAT'],
    // WITH ... WHERE
    ['MATCH (p:Person)-[:ACTED_IN]->(m) WITH p, count(m) AS films WHERE films > 3 AND p.bo‸', 'property', 'bo'],
    ['MATCH (p) WITH p WHERE p:Act‸', 'label', 'Act'],
    ['MATCH (p) WITH p WH‸', 'word', 'WH'],
    // MERGE ... ON CREATE SET
    ["MERGE (m:Movie {ti‸", 'property', 'ti'],
    ["MERGE (m:Movie {title: 'The Matrix'}) ON CREATE SET m.rel‸", 'property', 'rel'],
    ["MERGE (m:Movie {title: 'The Matrix'}) ON CREATE SET m.released = 1999, m.tag‸", 'property', 'tag'],
    ["MERGE (m:Movie {title: 'The Matrix'}) ON MATCH SET m:Cla‸", 'label', 'Cla'],
    ["MERGE (m:Movie {title: 'The Matrix'}) ON CRE‸", 'word', 'CRE'],
    // SET n:Label, SET n += map
    ['MATCH (n:Person) SET n:Dir‸', 'label', 'Dir'],
    ['MATCH (n:Person) SET n:Director:Pro‸', 'label', 'Pro'],
    ['MATCH (n) SET n += {na‸', 'property', 'na'],
    ['MATCH (n) SET n = {name: ‸', 'none'],
    // REMOVE
    ['MATCH (n:Person) REMOVE n:Act‸', 'label', 'Act'],
    ['MATCH (n:Person) REMOVE n.bo‸', 'property', 'bo'],
    // Variable-length patterns
    ["MATCH (k:Person {name: 'Keanu Reeves'})-[:KNOWS*1..3]->(f:Per‸", 'label', 'Per'],
    ['MATCH (a)-[:KNOWS*‸', 'none'],
    ['MATCH (a)-[:KNOWS*1..‸', 'none'],
    ['MATCH (a)-[r:KNOWS*..2 {sin‸', 'property', 'sin'],
    ['MATCH (a)-[*1..2]-(b:Mo‸', 'label', 'Mo'],
    // Named paths
    ['MATCH p = (a:Person)-[:ACT‸', 'relationshipType', 'ACT'],
    ['MATCH p = shortestPath((a:Person)-[:KNOWS*]-(b:Per‸', 'label', 'Per'],
    ['MATCH p = (a)-->(b) RETURN length(p), nodes(p)[0].na‸', 'property', 'na'],
    // labels(n), and properties of what a function gives
    ["MATCH (n) WHERE 'Person' IN labels(n) AND n.na‸", 'property', 'na'],
    ['MATCH (n) RETURN labels(n), n:Per‸', 'label', 'Per'],
    ['MATCH (n) RETURN lab‸', 'word', 'lab'],
    ['MATCH (p)-[:ACTED_IN]->(m) RETURN p, head(collect(m)).ti‸', 'property', 'ti'],
    ['MATCH ()-[r]->() RETURN startNode(r).na‸', 'property', 'na'],
    // CASE
    ['MATCH (n) RETURN CASE WHEN n:Mov‸', 'label', 'Mov'],
    ['MATCH (n) RETURN CASE n.‸', 'property', ''],
    ["MATCH (m) RETURN CASE WHEN m.released < 2000 THEN 'old' ELSE m.ti‸", 'property', 'ti'],
    ['MATCH (n) RETURN CASE WHEN n:Movie TH‸', 'word', 'TH'],
    // Pattern comprehensions
    ['MATCH (a:Person) RETURN [(a)-[:ACT‸', 'relationshipType', 'ACT'],
    ['MATCH (a:Person) RETURN [(a)-[:ACTED_IN]->(b:Mov‸', 'label', 'Mov'],
    ['MATCH (a:Person) RETURN [(a)-[:ACTED_IN]->(b) | b.na‸', 'property', 'na'],
    ['MATCH (a:Person) RETURN [(a)-->(b) WHERE b:Mov‸', 'label', 'Mov'],
    ['MATCH (a:Person) RETURN [(a)-[:ACTED_IN]->(b) | b.title] AS titles, a.na‸', 'property', 'na'],
    // List comprehensions
    ['MATCH p = (a)-->(b) RETURN [n IN nodes(p) WHERE n:Per‸', 'label', 'Per'],
    ['MATCH p = (a)-->(b) RETURN [n IN nodes(p) WHERE n.born > 1960 | n.na‸', 'property', 'na'],
    ['RETURN [x IN range(1, 10) WH‸', 'word', 'WH'],
    // Map literals
    ['MATCH (p:Person) RETURN {na‸', 'property', 'na'],
    ['MATCH (p:Person) RETURN {name: p.na‸', 'property', 'na'],
    ['MATCH (p:Person) RETURN {name: p.name, bo‸', 'property', 'bo'],
    ['MATCH (p:Person) RETURN {name: p.name, movies: [(p)-[:ACT‸', 'relationshipType', 'ACT'],
    ['MATCH (p:Person) RETURN {name: p.name, movies: [(p)-->(m:Mov‸', 'label', 'Mov'],
    ['MATCH (p:Person) RETURN {movies: [(p)-->(m) | m.title], ye‸', 'property', 'ye'],
    ['MATCH (p:Person) RETURN {name: p.name, born: ‸', 'none'],
    ['MATCH (p:Person) RETURN [{na‸', 'property', 'na'],
    ['CREATE (m:Movie {\n  title: "The Matrix",\n  rel‸', 'property', 'rel'],
    ['CREATE (m:Movie {\n  rel‸', 'property', 'rel'],
    ['CREATE (m:Movie {title:\n  ‸', 'none'],
    ['CREATE (m:Movie {title:\n  Ke‸', 'none'],
    ['MATCH (n:\n  Per‸', 'label', 'Per'],
    // UNWIND
    ['UNWIND $rows AS row MERGE (p:Per‸', 'label', 'Per'],
    ['UNWIND $rows AS row MERGE (p:Person {name: row.na‸', 'property', 'na'],
    ['UNWIND $rows AS row MERGE (p:Person {name: row.name}) SET p.bo‸', 'property', 'bo'],
    ['UNWIND [1, 2, 3] AS x RET‸', 'word', 'RET'],
    // FOREACH
    ['MATCH p = (a)-->(b) FOREACH (n IN nodes(p) | SET n:Vis‸', 'label', 'Vis'],
    ['MATCH p = (a)-->(b) FOREACH (n IN nodes(p) | SET n.see‸', 'property', 'see'],
    // Relationship properties, and both directions
    ['MATCH (p)-[r:ACTED_IN {rol‸', 'property', 'rol'],
    ['MATCH (m:Movie)<-[:DIR‸', 'relationshipType', 'DIR'],
    ['MATCH (m:Movie)\n  <-[:DIR‸', 'relationshipType', 'DIR'],
    ['MATCH (p)-[:ACTED_IN|:DIR‸', 'relationshipType', 'DIR'],
    // Pattern predicates and subqueries
    ['MATCH (p:Person) WHERE (p)-[:DIR‸', 'relationshipType', 'DIR'],
    ['MATCH (p:Person) WHERE NOT (p)-[:ACTED_IN]->(:Mov‸', 'label', 'Mov'],
    ['MATCH (p) WHERE COUNT { (p)-[:ACTED_IN]->(m:Mov‸', 'label', 'Mov'],
    // Strings holding a colon or a dot
    ["MATCH (m:Movie) WHERE m.tagline = 'Welcome to the Real World: a.b' AND m.ti‸", 'property', 'ti'],
    ["MATCH (m) WHERE m.title = 'a:b' AND m:Mov‸", 'label', 'Mov'],
    ['MATCH (m) WHERE m.title = "x.y" RETURN m.‸', 'property', ''],
    ["MATCH (m) WHERE m.title = 'it\\'s: m.' RETURN m.ti‸", 'property', 'ti'],
    ["MATCH (m) WHERE m.title = 'x.‸", 'none'],
    ["MATCH (m) WHERE m.title = 'x:‸", 'none'],
    ["MATCH (m) WHERE m.url = 'http://a.b' AND m:Mov‸", 'label', 'Mov'],
    // Comments holding a colon or a dot
    ['MATCH (m) // m:Movie, m.title\nRETURN m.ti‸', 'property', 'ti'],
    ['MATCH (m) /* m:Movie. */ WHERE m:Mov‸', 'label', 'Mov'],
    ["// don't\nMATCH (m:Mov‸", 'label', 'Mov'],
    ['MATCH (m) // m.‸', 'none'],
    ['MATCH (m) /* m:‸', 'none'],
    // Words of the language, where no name goes
    ['MATCH (m:Movie) RETURN m ORDER BY m.released DESC LIM‸', 'word', 'LIM'],
    ['MATCH (m:Movie) RETURN m.title AS ti‸', 'word', 'ti'],
    ['MATCH (m:Movie) ‸', 'none'],
  ]

  it.each(cases)('%s', (text, kind, typed) => {
    const result = at(text)
    expect(result.kind).toBe(kind)
    if (typed !== undefined) expect(result).toMatchObject({ typed })
  })
})
