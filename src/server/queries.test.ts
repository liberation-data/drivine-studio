import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addQuery, fileOf, listQueries, readBack, removeQuery, updateQuery, validateQuery, written } from './queries'

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

const keanu = { name: "Keanu's films", statement: 'MATCH (p:Person {name: $name})-->(m:Movie)\nRETURN m', parameters: '{"name": "Keanu Reeves"}' }

describe('a saved query', () => {
  it('is a .cypher file, its parameters in a leading comment, read back as it was written', async () => {
    const added = await addQuery(keanu)
    expect(added).toMatchObject({ id: "Keanu's films.cypher", name: "Keanu's films", statement: keanu.statement, parameters: keanu.parameters })
    const file = await readFile(join(home, 'queries', "Keanu's films.cypher"), 'utf8')
    expect(file).toBe('/* parameters\n{"name": "Keanu Reeves"}\n*/\nMATCH (p:Person {name: $name})-->(m:Movie)\nRETURN m\n')
    expect(readBack(written({ ...keanu, parameters: '' }))).toEqual({ statement: keanu.statement, parameters: '' })
    expect(await listQueries()).toHaveLength(1)
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
    expect(await listQueries()).toEqual([])
  })
})
