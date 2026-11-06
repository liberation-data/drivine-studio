import { DatabaseRegistry, DatabaseType, QuerySpecification } from '@liberation-data/drivine'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { check, connect, forget, NoGraphError, readSql, run, StatementError, toWrite } from './datasources'
import { readSchema } from './schema'

// SQLite needs no database running: each file here is made in a folder of the test's own, by Drivine, as an
// application using it would make one.

let dir: string
let made = 0
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-sqlite-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A file holding a small graph, written by Drivine through a provider of the test's own. */
async function graphFile(graph = 'drivine'): Promise<string> {
  const file = join(dir, `graph-${++made}.db`)
  const provider = DatabaseRegistry.getInstance().builder().withType(DatabaseType.SQLITE).databaseName(file).defaultGraphPath(graph)
    .register(`sqlite-fixture-${made}`)
  const session = await provider.connect()
  try {
    await session.query(new QuerySpecification().withStatement({
      text: "CREATE (:Person {name: 'Ann', born: 1970})-[:KNOWS {since: 2001}]->(:Person:Pet {name: 'Bo'})",
      language: 'CYPHER',
    }))
  } finally {
    await session.release()
    await provider.end()
  }
  return file
}

/** A file with no graph in it: SQLite's own, with a table of someone else's. */
function otherFile(): string {
  const file = join(dir, `other-${++made}.db`)
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE notes (body TEXT)')
  db.close()
  return file
}

/** A connection to the file, made for the test, and forgotten after it. */
const connections: Connection[] = []
const on = (file: string, more: Partial<Connection> = {}): Connection => {
  const connection: Connection = { id: `sqlite-${++made}`, name: 'SQLite', type: 'SQLITE', host: '', database: file, source: 'studio', ...more }
  connections.push(connection)
  return connection
}
afterAll(async () => {
  for (const c of connections) await forget(c.id)
})

/**
 * The file, and what its write-ahead log holds, where a write would go first. A reader of a file in that mode may
 * leave the log there empty, as any reader does, and its shared index changes with a read: neither is a write.
 */
const written = (file: string): { file: string; log: number } => ({
  file: readFileSync(file).toString('base64'),
  log: existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).length : 0,
})

/** The tables in the file, read as anyone may read them. */
function tablesIn(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => String(row.name))
  } finally {
    db.close()
  }
}

describe('run, on SQLite', () => {
  it('compiles Cypher to SQLite\'s SQL, and gives each node, relationship and path whole', async () => {
    const connection = on(await graphFile())
    const result = await run(connection, 'MATCH (a)-[r:KNOWS]->(b) RETURN a, r, b.name AS name')
    expect(result.columns).toEqual(['a', 'r', 'name'])
    expect(result.rows).toEqual([[
      { kind: 'node', node: { id: '1', labels: ['Person'], properties: { name: 'Ann', born: 1970 } } },
      { kind: 'relationship', relationship: { id: '1', type: 'KNOWS', from: '1', to: '2', properties: { since: 2001 } } },
      { kind: 'value', value: 'Bo' },
    ]])
    const path = await run(connection, 'MATCH p = ()-->() RETURN p')
    expect(path.rows[0]![0]).toMatchObject({ kind: 'path', nodes: [{ id: '1' }, { id: '2', labels: ['Person', 'Pet'] }], relationships: [{ id: '1' }] })
    const listed = await run(connection, 'MATCH (n:Person) RETURN collect(n) AS people')
    expect(listed.graph.nodes.map(n => n.id).sort()).toEqual(['1', '2'])
  })

  it('binds a statement\'s parameters, where it reads and where it writes', async () => {
    const connection = on(await graphFile(), { allowWrites: true })
    const read = await run(connection, 'MATCH (n) WHERE n.name IN $names AND n.born >= $born RETURN n.name AS name', { names: ['Ann', 'Bo'], born: 1960 })
    expect(read.rows).toEqual([[{ kind: 'value', value: 'Ann' }]])
    await run(connection, 'CREATE (c:Cat {name: $name}) RETURN c.name AS name', { name: 'Cy' }, 10, { writes: true })
    expect((await run(connection, 'MATCH (c:Cat {name: $name}) RETURN count(c) AS c', { name: 'Cy' })).rows).toEqual([[{ kind: 'value', value: 1 }]])
  })

  it('gives booleans, nulls, floats, lists, maps and text that looks like JSON as the values they are', async () => {
    const result = await run(on(await graphFile()), `RETURN true AS t, null AS n, 1.5 AS f, [1, 'a', false, null] AS l, {k: 'v'} AS m, '{"a":1}' AS j`)
    expect(result.rows).toEqual([[
      { kind: 'value', value: true },
      { kind: 'null' },
      { kind: 'value', value: 1.5 },
      { kind: 'list', items: [{ kind: 'value', value: 1 }, { kind: 'value', value: 'a' }, { kind: 'value', value: false }, { kind: 'null' }] },
      { kind: 'map', entries: [{ key: 'k', value: { kind: 'value', value: 'v' } }] },
      { kind: 'value', value: '{"a":1}' },
    ]])
  })

  it('reads at most the limit, and says there were more', async () => {
    const result = await run(on(await graphFile()), 'MATCH (n) RETURN n.name AS name ORDER BY name', {}, 1)
    expect(result.rows).toEqual([[{ kind: 'value', value: 'Ann' }]])
    expect(result.truncated).toBe(true)
  })

  it('leaves the file as it was where it may not write: a CREATE is refused, and SQL that writes is refused by SQLite', async () => {
    const file = await graphFile()
    const before = written(file)
    const connection = on(file)
    await expect(run(connection, "CREATE (:Intruder {name: 'x'})")).rejects.toThrow(/^The studio reads and never writes.* is not sent\.$/)
    // The studio's own SQL is never sent a write, but the file is opened read-only all the same, which SQLite holds to.
    const insert = readSql(connection, `INSERT INTO drivine_node (labels, props) VALUES ('["Intruder"]', '{}')`)
    await expect(insert).rejects.toThrow(StatementError)
    await expect(readSql(connection, 'DELETE FROM drivine_node')).rejects.toThrow(/^The studio reads and never writes.*readonly database/)
    await run(connection, 'MATCH (n) RETURN n')
    await check(connection)
    expect(written(file)).toEqual(before)
    expect((await run(connection, 'MATCH (n) RETURN count(n) AS c')).rows).toEqual([[{ kind: 'value', value: 2 }]])
  })

  it('runs a statement that writes, and commits it, where the connection allows writes', async () => {
    const connection = on(await graphFile(), { allowWrites: true })
    const written = await run(connection, "MATCH (a {name: 'Ann'}) CREATE (a)-[:OWNS]->(c:Cat {name: 'Cy'}) RETURN c.name AS name", {}, 10, { writes: true })
    expect(written).toMatchObject({ columns: ['name'], rows: [[{ kind: 'value', value: 'Cy' }]], written: { counts: null } })
    const read = await run(connection, 'MATCH (:Person)-[:OWNS]->(c:Cat) RETURN c.name AS name')
    expect(read.rows).toEqual([[{ kind: 'value', value: 'Cy' }]])
  })

  it('refuses a path with no file there, and makes none, even where the connection allows writes', async () => {
    const file = join(dir, 'missing.db')
    const connection = on(file, { allowWrites: true })
    await expect(check(connection)).rejects.toThrow(ConnectionError)
    await expect(check(connection)).rejects.toThrow(`There is no SQLite file at ${file}.`)
    await expect(run(connection, 'CREATE (:Person)', {}, 1, { writes: true })).rejects.toThrow(ConnectionError)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter(name => name.startsWith('missing'))).toEqual([])
  })

  it('opens a file to write without making it, should it go between its check and its opening', () => {
    const file = join(dir, 'gone #1?.db')
    expect(() => new DatabaseSync(toWrite(file))).toThrow(/unable to open/)
    expect(existsSync(file)).toBe(false)
    const there = otherFile()
    const db = new DatabaseSync(toWrite(there))
    try {
      db.exec('INSERT INTO notes VALUES (1)')
    } finally {
      db.close()
    }
  })

  it('refuses a folder as the file', async () => {
    await expect(check(on(dir))).rejects.toThrow(`${dir} is not a file.`)
  })

  it('says a file without the graph\'s tables doesn\'t hold the graph, and makes none, even where the connection allows writes', async () => {
    const file = otherFile()
    const connection = on(file, { allowWrites: true })
    await expect(check(connection)).rejects.toThrow(NoGraphError)
    await expect(check(connection)).rejects.toThrow(`SQLite has no graph drivine in ${file}: the table drivine_node is not there.`)
    await expect(run(connection, 'CREATE (:Person)', {}, 1, { writes: true })).rejects.toThrow(NoGraphError)
    expect(tablesIn(file)).toEqual(['notes'])
  })

  it('reads the graph the connection names, and says where it is another the file holds', async () => {
    const file = await graphFile('movies')
    await expect(check(on(file, { graph: 'movies' }))).resolves.toMatchObject({ milliseconds: expect.any(Number) })
    await expect(check(on(file))).rejects.toThrow(/no graph drivine/)
    expect(tablesIn(file)).toEqual(['movies_edge', 'movies_node', 'movies_schema'])
  })

  it('says a file that is not SQLite\'s is not', async () => {
    const file = join(dir, 'notes.txt')
    rmSync(file, { force: true })
    writeFileSync(file, 'not a database, but long enough to be read as a header of one, which it is not.')
    await expect(check(on(file))).rejects.toThrow(/not a SQLite database/)
  })

  it('refuses a relative path from the environment, which the studio\'s server would read from its own folder', async () => {
    const connection = on('data/graph.db', { id: 'environment-sqlite', source: 'environment' })
    await expect(check(connection)).rejects.toThrow(/whole path/)
  })

  it('says a value a statement could not take is the person\'s to fix', async () => {
    const connection = on(await graphFile())
    await expect(run(connection, "MATCH (n) WHERE n.name =~ '[' RETURN n")).rejects.toThrow(StatementError)
  })

  it('connects a result\'s nodes by the ids it gave them, reading only', async () => {
    const file = await graphFile()
    const before = written(file)
    expect(await connect(on(file), ['1', '2'])).toEqual({
      relationships: [{ id: '1', type: 'KNOWS', from: '1', to: '2', properties: { since: 2001 } }],
      truncated: false,
    })
    expect(written(file)).toEqual(before)
  })
})

describe('readSchema, on SQLite', () => {
  it('reads every label and relationship type, and the property keys, from the graph\'s tables', async () => {
    expect(await readSchema(on(await graphFile()))).toEqual({
      labels: ['Person', 'Pet'],
      relationshipTypes: ['KNOWS'],
      propertyKeys: ['born', 'name', 'since'],
    })
  })

  it('reads labels and keys with quotes, dots and letters past ASCII as they are, not as JSON writes them', async () => {
    const file = await graphFile()
    await run(on(file, { allowWrites: true }), "CREATE (:`Odd \"La'bel`:`ünï cødé` {`we\"ird key`: 1, `a.b`: 2})", {}, 1, { writes: true })
    expect(await readSchema(on(file))).toEqual({
      labels: ['Odd "La\'bel', 'Person', 'Pet', 'ünï cødé'],
      relationshipTypes: ['KNOWS'],
      propertyKeys: ['a.b', 'born', 'name', 'since', 'we"ird key'],
    })
  })
})
