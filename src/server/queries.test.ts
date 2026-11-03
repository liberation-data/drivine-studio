import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addFolder, addQuery, fileOf, listQueries, readBack, removeFolder, removeQuery, updateQuery, validateQuery, written } from './queries'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-queries-'))
  process.env.DRIVINE_STUDIO_HOME = home
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const keanu = { name: "Keanu's films", statement: 'MATCH (p:Person {name: $name})-->(m:Movie)\nRETURN m', parameters: '{"name": "Keanu Reeves"}', folder: '' }

describe('a saved query', () => {
  it('is a .cypher file, its parameters in a leading comment, read back as it was written', async () => {
    const added = await addQuery(keanu)
    expect(added).toMatchObject({ id: "Keanu's films.cypher", name: "Keanu's films", statement: keanu.statement, parameters: keanu.parameters })
    const file = await readFile(join(home, 'queries', "Keanu's films.cypher"), 'utf8')
    expect(file).toBe('/* parameters\n{"name": "Keanu Reeves"}\n*/\nMATCH (p:Person {name: $name})-->(m:Movie)\nRETURN m\n')
    expect(readBack(written({ ...keanu, parameters: '' }))).toEqual({ statement: keanu.statement, parameters: '' })
    expect((await listQueries()).queries).toHaveLength(1)
  })

  it('takes a name no file system would as one it does, and none that reads as a path', () => {
    expect(fileOf('a/b: c?')).toBe('a b c.cypher')
    expect(fileOf('../../etc/passwd')).toBe('etc passwd.cypher')
    expect(() => validateQuery({ name: '///', statement: 'RETURN 1' })).toThrow(/a name/)
    expect(() => validateQuery({ name: 'x', statement: 'RETURN 1', parameters: '{"a": "*/"}' })).toThrow(/\*\//)
  })

  it('renames its file when saved under a new name, and will not save over another', async () => {
    const added = await addQuery(keanu)
    await addQuery({ ...keanu, name: 'Other' })
    await expect(addQuery(keanu)).rejects.toThrow(/already/)
    await expect(updateQuery(added.id, { ...keanu, name: 'Other' })).rejects.toThrow(/already/)
    const renamed = await updateQuery(added.id, { ...keanu, name: 'Films of Keanu', statement: 'RETURN 1' })
    expect(renamed).toMatchObject({ id: 'Films of Keanu.cypher', statement: 'RETURN 1' })
    expect((await readdir(join(home, 'queries'))).sort()).toEqual(['Films of Keanu.cypher', 'Other.cypher'])
  })

  it('is removed by its id, and an id that would reach outside the folder is no query', async () => {
    const added = await addQuery(keanu)
    await expect(removeQuery('../connections.json')).rejects.toThrow(/no saved query/)
    await expect(removeQuery('../x.cypher')).rejects.toThrow(/no saved query/)
    await removeQuery(added.id)
    expect(await listQueries()).toEqual({ folders: [], queries: [] })
  })
})

describe('folders of queries', () => {
  it('keep queries apart, nest, and are listed with what they hold', async () => {
    await addFolder('Films')
    await addFolder('Films/Keanu')
    const kept = await addQuery({ ...keanu, folder: 'Films/Keanu' })
    expect(kept).toMatchObject({ id: "Films/Keanu/Keanu's films.cypher", folder: 'Films/Keanu', name: "Keanu's films" })
    await addQuery(keanu)
    const shelf = await listQueries()
    expect(shelf.folders).toEqual([
      { path: 'Films', name: 'Films', folders: 1, queries: 0 },
      { path: 'Films/Keanu', name: 'Keanu', folders: 0, queries: 1 },
    ])
    expect(shelf.queries.map(q => q.id).sort()).toEqual(["Films/Keanu/Keanu's films.cypher", "Keanu's films.cypher"])
  })

  it('move a query when it is saved into another', async () => {
    await addFolder('Films')
    const top = await addQuery(keanu)
    const moved = await updateQuery(top.id, { ...keanu, folder: 'Films' })
    expect(moved.id).toBe("Films/Keanu's films.cypher")
    expect(await readdir(join(home, 'queries'))).toEqual(['Films'])
    await expect(addQuery({ ...keanu, folder: 'Nowhere' })).rejects.toThrow(/no folder Nowhere/)
  })

  it('are made only where a folder is, named as a folder can be, and removed only when empty', async () => {
    await expect(addFolder('a/b')).rejects.toThrow(/no folder a/)
    await expect(addFolder('../out')).rejects.toThrow(/no folder/)
    await expect(addFolder('a/b/c/d/e')).rejects.toThrow(/no folder/)
    await addFolder('Films')
    await expect(addFolder('Films')).rejects.toThrow(/already/)
    await addQuery({ ...keanu, folder: 'Films' })
    await expect(removeFolder('Films')).rejects.toThrow(/not empty/)
    await removeQuery("Films/Keanu's films.cypher")
    await removeFolder('Films')
    expect(await listQueries()).toEqual({ folders: [], queries: [] })
    await expect(removeQuery('Films/../../x.cypher')).rejects.toThrow(/no saved query/)
  })
})
