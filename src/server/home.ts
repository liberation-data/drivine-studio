import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the studio keeps what it is told: DRIVINE_STUDIO_HOME, or `~/.drivine-studio`. What is there may hold
 * passwords, so only its owner may read it.
 */
export const studioHome = (): string => process.env.DRIVINE_STUDIO_HOME ?? join(homedir(), '.drivine-studio')

/** A file in the studio's home, as JSON, or undefined when it is not there yet. */
export async function readHomeFile<T>(name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(studioHome(), name), 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/**
 * Writes a file in the studio's home, as JSON, readable by its owner alone. It is written beside the file and moved
 * over it, so a crash part way leaves the old file whole.
 */
export async function writeHomeFile(name: string, value: unknown): Promise<void> {
  await mkdir(studioHome(), { recursive: true, mode: 0o700 })
  const file = join(studioHome(), name)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

// One change at a time, so two at once cannot each write a file over the other's. On globalThis, since Next may
// give each route its own copy of this module, and the routes change the same files.
const queue = globalThis as typeof globalThis & { drivineStudioChanges?: Promise<unknown> }

/** Runs a change to the studio's files once every change before it has finished. */
export function serially<T>(change: () => Promise<T>): Promise<T> {
  const next = (queue.drivineStudioChanges ?? Promise.resolve()).then(change, change)
  queue.drivineStudioChanges = next.catch(() => undefined)
  return next
}
