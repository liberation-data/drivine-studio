import { spawn } from 'node:child_process'

import { dockerArgs, dockerCommand, STUDIO_LABEL } from '../studio/docker'
import type { Container, DockerDraft, DockerHere, DockerRun, DockerStatus, Job } from '../studio/docker'
import { DATABASE_TYPES } from '../studio/database'
import type { DatabaseType } from '../studio/database'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { check, forget, StatementError } from './datasources'

/*
 * A database to try the studio on, started in Docker on this machine, as Neo4j Desktop starts one: the container the
 * connection editor's command describes, run by the studio's server rather than pasted into a terminal. The server
 * builds the container from the connection's fields alone (`dockerCommand`), runs `docker` with a list of arguments and
 * no shell, and stops or removes only a container that carries the studio's label.
 */

/** How long a database is waited for: Oracle Free opens its database for the first time in a minute or two. */
const WAIT_MS: Partial<Record<DatabaseType, number>> = { ORACLE: 6 * 60_000 }
const WAIT_DEFAULT_MS = 2 * 60_000
const POLL_MS = 2_000

/**
 * Where Docker's command is, as well as the PATH given. The desktop app, opened from the Finder, is given the system's
 * PATH only, which has neither Docker Desktop's nor Homebrew's directory in it.
 */
const PATH = [
  process.env.PATH ?? '',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
].filter(Boolean).join(':')

interface Ran {
  code: number
  out: string
  err: string
}

/** Runs `docker` with these arguments, each line it prints given to `line` as it comes. Never through a shell. */
export function docker(args: readonly string[], line?: (text: string) => void): Promise<Ran> {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn('docker', args, { env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: '', err: e instanceof Error ? e.message : String(e) })
      return
    }
    const each = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString()
      if (into === 'out') out += text
      else err += text
      for (const part of text.split(/[\r\n]+/)) if (part.trim()) line?.(part.trim())
    }
    child.stdout.on('data', (chunk: Buffer) => each(chunk, 'out'))
    child.stderr.on('data', (chunk: Buffer) => each(chunk, 'err'))
    child.on('error', (e: NodeJS.ErrnoException) => resolve({ code: -1, out, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }))
    child.on('close', code => resolve({ code: code ?? -1, out, err }))
  })
}

/** Whether Docker is installed, and its engine running. */
export async function dockerHere(): Promise<DockerHere> {
  const ran = await docker(['version', '--format', '{{.Server.Version}}'])
  if (ran.code === 0) return { kind: 'ready' }
  if (ran.err === 'ENOENT') {
    return { kind: 'absent', why: 'Docker is not installed here. Install Docker Desktop (docker.com), start it, and try again.' }
  }
  return { kind: 'absent', why: 'Docker is installed but its engine is not running. Start Docker Desktop, and try again.' }
}

/** What `docker inspect` says of a container, as far as the studio needs it. */
export function containerOf(inspected: unknown, run: Pick<DockerRun, 'inside'>): Container {
  const it = (Array.isArray(inspected) ? inspected[0] : inspected) as
    | { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> | null }; HostConfig?: { PortBindings?: Record<string, { HostPort?: string }[] | null> | null } }
    | undefined
  if (!it) return { kind: 'missing' }
  const binding = it.HostConfig?.PortBindings?.[`${run.inside}/tcp`]?.[0]?.HostPort
  return {
    kind: it.State?.Running ? 'running' : 'stopped',
    ours: it.Config?.Labels?.[STUDIO_LABEL] === '1',
    port: binding ? Number(binding) : null,
  }
}

async function container(run: DockerRun): Promise<Container> {
  const ran = await docker(['container', 'inspect', run.name])
  if (ran.code !== 0) return { kind: 'missing' }
  try {
    return containerOf(JSON.parse(ran.out), run)
  } catch {
    return { kind: 'missing' }
  }
}

// One start at a time for each container, kept across the dev server's reloads of this module.
const jobs: Map<string, Job> = ((globalThis as { __studioDockerJobs?: Map<string, Job> }).__studioDockerJobs ??= new Map())

const active = (job: Job | undefined) => job !== undefined && job.state !== 'ready' && job.state !== 'failed'

/** The container for a draft, or why there is none. */
function runOf(draft: DockerDraft): { run: DockerRun; fill: Partial<DockerDraft> } {
  const made = dockerCommand(draft)
  if (made.kind === 'none') throw new ConnectionError(made.why)
  return { run: made.run, fill: made.fill }
}

export async function status(draft: DockerDraft): Promise<DockerStatus> {
  const { run } = runOf(draft)
  const here = await dockerHere()
  return { docker: here, container: here.kind === 'ready' ? await container(run) : { kind: 'missing' }, job: jobs.get(run.name) ?? null }
}

/** What a draft says of the type, checked: the browser's word for it is not taken on trust. */
export function draftOf(input: unknown): DockerDraft {
  const given = (input ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof given[key] === 'string' ? (given[key] as string) : '')
  const type = text('type') as DatabaseType
  if (!DATABASE_TYPES.includes(type)) throw new ConnectionError(`The studio runs no database of type ${type || 'none'} in Docker.`)
  return { type, host: text('host'), port: text('port'), user: text('user'), password: text('password'), database: text('database') }
}

/**
 * Starts the container, pulling its image first when it is not here, and waits until the database answers. Returns at
 * once; the job says how it is going. A container the studio made before is started again as it is, provided it was
 * made for the same port; one it did not make is left alone.
 */
export async function start(draft: DockerDraft): Promise<Job> {
  const { run, fill } = runOf(draft)
  const current = jobs.get(run.name)
  if (active(current)) return current!
  const here = await dockerHere()
  if (here.kind === 'absent') throw new ConnectionError(here.why)
  const there = await container(run)
  if (there.kind !== 'missing' && !there.ours) {
    throw new ConnectionError(`A container named ${run.name} is here that the studio did not make. Remove it, or start it yourself.`)
  }
  if (there.kind !== 'missing' && there.port !== null && there.port !== run.port) {
    throw new ConnectionError(`${run.name} was made for port ${there.port}. Set Port to ${there.port}, or remove it to make one for ${run.port}.`)
  }
  const job: Job = { state: 'starting', detail: '', started: Date.now() }
  jobs.set(run.name, job)
  void startIn(job, run, { ...draft, ...fill }, there).catch((e: unknown) => {
    job.state = 'failed'
    job.error = e instanceof Error ? e.message : String(e)
  })
  return job
}

async function startIn(job: Job, run: DockerRun, settings: DockerDraft, there: Container) {
  const say = (text: string) => {
    job.detail = text
  }
  if (there.kind === 'missing') {
    if ((await docker(['image', 'inspect', run.image])).code !== 0) {
      job.state = 'pulling'
      say(`Downloading ${run.image}`)
      const pulled = await docker(['pull', run.image], say)
      if (pulled.code !== 0) throw new Error(`Docker could not download ${run.image}: ${lastLine(pulled.err) || 'no reason given'}`)
    }
    job.state = 'starting'
    say(`Starting ${run.name}`)
    const ran = await docker(dockerArgs(run))
    if (ran.code !== 0) throw new Error(portTaken(ran.err) ? `Port ${run.port} is in use on this machine. Choose another port.` : lastLine(ran.err))
  } else if (there.kind === 'stopped') {
    job.state = 'starting'
    say(`Starting ${run.name} again`)
    const ran = await docker(['start', run.name])
    if (ran.code !== 0) throw new Error(portTaken(ran.err) ? `Port ${run.port} is in use on this machine. Choose another port.` : lastLine(ran.err))
  }
  job.state = 'waiting'
  say('Waiting for the database to answer')
  const answered = await waitFor(settings, run, say)
  job.milliseconds = answered
  job.state = 'ready'
  say(`Answered in ${Math.round(answered / 1000)} s`)
}

const portTaken = (err: string) => /port is already allocated|address already in use/i.test(err)
const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''

/**
 * Tries the database until it answers, or the wait runs out. It answers when the studio's own test goes through, or
 * when it is turned down for what is in it rather than for not being there: a new Postgres has no graph's tables yet.
 */
async function waitFor(settings: DockerDraft, run: DockerRun, say: (text: string) => void): Promise<number> {
  const started = Date.now()
  const limit = WAIT_MS[settings.type] ?? WAIT_DEFAULT_MS
  const connection: Connection = {
    id: `docker-${run.name}-${started}`,
    name: run.name,
    type: settings.type,
    host: 'localhost',
    port: run.port,
    ...(settings.user ? { user: settings.user } : {}),
    ...(settings.password ? { password: settings.password } : {}),
    ...(settings.database ? { database: settings.database } : {}),
    source: 'studio',
  }
  try {
    for (;;) {
      try {
        await check(connection)
        return Date.now() - started
      } catch (e) {
        if (e instanceof StatementError) return Date.now() - started
        if (Date.now() - started > limit) {
          throw new Error(`The database did not answer in ${Math.round(limit / 60_000)} minutes: ${e instanceof Error ? e.message : String(e)}`)
        }
        say(`Waiting for the database to answer (${Math.round((Date.now() - started) / 1000)} s)`)
        // A provider made before the database was up can hold a connection that never will be.
        await forget(connection.id)
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
    }
  } finally {
    await forget(connection.id)
  }
}

/** Stops the studio's container, keeping its data, or removes it, data and all. Never one the studio did not make. */
export async function stop(draft: DockerDraft, remove: boolean): Promise<Container> {
  const { run } = runOf(draft)
  const there = await container(run)
  if (there.kind === 'missing') return there
  if (!there.ours) throw new ConnectionError(`The studio did not make ${run.name}, so it leaves it alone.`)
  const ran = await docker(remove ? ['rm', '-f', run.name] : ['stop', run.name])
  if (ran.code !== 0) throw new Error(lastLine(ran.err))
  jobs.delete(run.name)
  return container(run)
}
