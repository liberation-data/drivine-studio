import { describe, expect, it } from 'vitest'
import { dockerArgs, dockerCommand, fillFor, listed, shellWord, TEST_PASSWORD } from './docker'
import type { DockerDraft } from './docker'

const draft = (patch: Partial<DockerDraft>): DockerDraft => ({ type: 'POSTGRES', host: 'localhost', port: '', user: '', password: '', database: '', ...patch })
const command = (patch: Partial<DockerDraft>) => {
  const made = dockerCommand(draft(patch))
  if (made.kind !== 'command') throw new Error(made.why)
  return made
}

describe('a database to try the studio on, in Docker', () => {
  it('runs Postgres as Drivine tests it, with the form’s settings or the tests’ own', () => {
    const made = command({ type: 'POSTGRES' })
    expect(made.command).toBe(
      'docker run -d --name drivine-postgres \\\n  --label org.drivine.studio=1 \\\n  -p 5432:5432 \\\n  -e POSTGRES_USER=drivine \\\n  -e POSTGRES_PASSWORD=drivine-test \\\n  -e POSTGRES_DB=drivine \\\n  pgvector/pgvector:pg16',
    )
    expect(made.fill).toEqual({ port: '5432', user: 'drivine', password: TEST_PASSWORD, database: 'drivine' })
    expect(command({ type: 'POSTGRES', port: '55432', user: 'ada', password: 'secret', database: 'matrix' }).command).toContain('-p 55432:5432 \\\n  -e POSTGRES_USER=ada \\\n  -e POSTGRES_PASSWORD=secret \\\n  -e POSTGRES_DB=matrix')
  })

  it('runs Neo4j as the neo4j user, and warns of a password Neo4j refuses', () => {
    const made = command({ type: 'NEO4J', user: 'ada', password: 'short' })
    expect(made.command).toContain('-e NEO4J_AUTH=neo4j/short \\\n  neo4j:latest')
    expect(made.fill.user).toBe('neo4j')
    expect(made.note).toContain('shorter than 8')
    expect(command({ type: 'NEO4J' }).note).toBe('Its user is neo4j.')
  })

  it('runs Memgraph with no users, and FalkorDB at the release Drivine passes on, with a password only when given', () => {
    expect(command({ type: 'MEMGRAPH' }).command).toBe('docker run -d --name drivine-memgraph \\\n  --label org.drivine.studio=1 \\\n  -p 7687:7687 \\\n  memgraph/memgraph:latest')
    expect(command({ type: 'FALKORDB' }).command).toBe('docker run -d --name drivine-falkordb \\\n  --label org.drivine.studio=1 \\\n  -p 6379:6379 \\\n  falkordb/falkordb:6.0.3')
    expect(command({ type: 'FALKORDB', password: 'pw' }).command).toContain("-e 'REDIS_ARGS=--requirepass pw'")
  })

  it('runs Oracle Free with an ordinary user of the pluggable database', () => {
    const made = command({ type: 'ORACLE', port: '1522' })
    expect(made.command).toContain('-p 1522:1521')
    expect(made.command).toContain('-e APP_USER=drivine')
    expect(made.command).toContain('gvenzl/oracle-free:23-faststart')
    expect(made.fill.database).toBe('FREEPDB1')
  })

  it('has none for Neptune, or for a database on another machine', () => {
    expect(dockerCommand(draft({ type: 'NEPTUNE' })).kind).toBe('none')
    expect(dockerCommand(draft({ host: 'db.example.com' }))).toMatchObject({ kind: 'none', why: expect.stringContaining('localhost') })
    expect(dockerCommand(draft({ host: '127.0.0.1' })).kind).toBe('command')
  })

  it('quotes what the shell would read otherwise', () => {
    expect(shellWord('drivine-test')).toBe('drivine-test')
    expect(shellWord('two words')).toBe("'two words'")
    expect(shellWord("it's $HOME")).toBe("'it'\\''s $HOME'")
    expect(command({ type: 'POSTGRES', password: 'p@ss word!' }).command).toContain("-e 'POSTGRES_PASSWORD=p@ss word!'")
  })
})

describe('filling the form from the command', () => {
  it('fills only what is empty', () => {
    const made = command({ type: 'POSTGRES', port: '55432', user: 'studio', database: 'studio' })
    expect(fillFor(made.fill, draft({ port: '55432', user: 'studio', database: 'studio' }), false)).toEqual({ password: TEST_PASSWORD })
    expect(fillFor(command({}).fill, draft({}), false)).toEqual(command({}).fill)
  })

  it('never replaces a password the studio keeps, and fills nothing when nothing is empty', () => {
    const filled = { port: '55432', user: 'studio', database: 'studio' }
    expect(fillFor(command(filled).fill, draft(filled), true)).toEqual({})
  })

  it('names the fields as a list is read', () => {
    expect(listed(['Password'])).toBe('Password')
    expect(listed(['Port', 'User'])).toBe('Port and User')
    expect(listed(['Port', 'User', 'Password', 'Database'])).toBe('Port, User, Password and Database')
  })
})

describe('the container as the studio runs it', () => {
  it('is the same container as the command to copy, as a list of arguments with nothing for a shell to read', () => {
    const made = command({ type: 'POSTGRES', port: '55432', password: "it's; rm -rf ~" })
    expect(dockerArgs(made.run)).toEqual([
      'run', '-d', '--name', 'drivine-postgres', '--label', 'org.drivine.studio=1', '-p', '55432:5432',
      '-e', 'POSTGRES_USER=drivine', '-e', "POSTGRES_PASSWORD=it's; rm -rf ~", '-e', 'POSTGRES_DB=drivine',
      'pgvector/pgvector:pg16',
    ])
    // The command to copy quotes it for the shell; the arguments carry it as it is.
    expect(made.command).toContain("-e 'POSTGRES_PASSWORD=it'\\''s; rm -rf ~'")
  })

  it('has no container for a port that is not one', () => {
    expect(dockerCommand(draft({ port: '99999' }))).toMatchObject({ kind: 'none' })
    expect(dockerCommand(draft({ port: '54x' }))).toMatchObject({ kind: 'none' })
  })
})
