import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addModelPath, findModelFiles, listModelPaths, ModelPathError, parseModel, readCatalog, removeModelPath } from './models'

let dir: string
const saved = { ...process.env }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-models-'))
  process.env.DRIVINE_STUDIO_HOME = join(dir, 'home')
  delete process.env.DRIVINE_STUDIO_MODELS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
})

const sample = () => readFile(new URL('./fixtures/sample.json', import.meta.url), 'utf8')

/** Writes a module's model file, as a library would, and gives its path. */
async function module(path: string, model: unknown): Promise<string> {
  await mkdir(join(dir, path, '.drivine'), { recursive: true })
  const file = join(dir, path, '.drivine', 'model.json')
  await writeFile(file, typeof model === 'string' ? model : JSON.stringify(model))
  return file
}

const model = (name: string, entries: { fragments?: unknown[]; views?: unknown[] } = {}) => ({
  format: 'drivine-model/1',
  generator: { library: 'drivine4j', version: '1', language: 'kotlin' },
  module: name,
  fragments: entries.fragments ?? [],
  relationshipFragments: [],
  views: entries.views ?? [],
})
const fragment = (id: string, removed?: boolean) =>
  ({ id, name: id.split('.').pop(), labels: [id.split('.').pop()], properties: [], ...(removed ? { removed } : {}) })

describe('parseModel', () => {
  it('reads the sample domain', async () => {
    const parsed = parseModel(await sample())
    expect(parsed.module).toBe('drivine4j-sample')
    expect([parsed.fragments.length, parsed.relationshipFragments.length, parsed.views.length]).toEqual([14, 1, 10])
  })

  it.each([
    ['{', 'It is not JSON'],
    ['null', 'It is not a model file.'],
    [JSON.stringify({ ...model('m'), format: 'drivine-model/2' }), 'Its format is drivine-model/2, which this studio does not read'],
    [JSON.stringify({ ...model('m'), views: undefined }), 'It has no list of views.'],
  ])('refuses %s', (text, message) => {
    expect(() => parseModel(text)).toThrow(message)
  })

  it('skips keys it does not know, as a later version within the format may add them', () => {
    expect(parseModel(JSON.stringify({ ...model('m'), later: true })).module).toBe('m')
  })
})

describe('findModelFiles', () => {
  it('finds each module\'s file below a folder, sorted, and none in folders a build fills', async () => {
    const b = await module('repo/b', model('b'))
    const a = await module('repo/a', model('a'))
    await module('repo/node_modules/dep', model('dep'))
    await module('repo/a/build/x', model('x'))
    expect(await findModelFiles(join(dir, 'repo'))).toEqual([a, b])
  })

  it('takes a model file named itself', async () => {
    const file = await module('one', model('one'))
    expect(await findModelFiles(file)).toEqual([file])
  })

  it('looks no deeper than a module of a module needs', async () => {
    await module('deep/1/2/3/4/5/6/7', model('deep'))
    expect(await findModelFiles(join(dir, 'deep'))).toEqual([])
  })
})

describe('readCatalog', () => {
  it('merges the modules\' entries by id, and says which module each is from', async () => {
    await module('repo/a', model('a', { fragments: [fragment('x.A')] }))
    await module('repo/b', model('b', { fragments: [fragment('x.B')] }))
    const catalog = await readCatalog([join(dir, 'repo')])
    expect(catalog.models.map(m => m.module)).toEqual(['a', 'b'])
    expect(catalog.fragments.map(f => [f.id, f.module])).toEqual([['x.A', 'a'], ['x.B', 'b']])
    expect(catalog.problems).toEqual([])
  })

  it.each([
    ['a', true],
    ['b', false],
  ])('takes an id current in one module over the same id removed in another, as when a class moves: removed in %s', async (_, firstRemoved) => {
    await module('repo/a', model('a', { fragments: [fragment('x.Moved', firstRemoved)] }))
    await module('repo/b', model('b', { fragments: [fragment('x.Moved', !firstRemoved)] }))
    const catalog = await readCatalog([join(dir, 'repo')])
    expect(catalog.fragments).toMatchObject([{ id: 'x.Moved', module: firstRemoved ? 'b' : 'a' }])
    expect(catalog.fragments[0]?.removed).toBeUndefined()
    expect(catalog.problems).toEqual([])
  })

  it('keeps an entry removed everywhere, removed', async () => {
    await module('repo/a', model('a', { fragments: [fragment('x.Gone', true)] }))
    expect((await readCatalog([join(dir, 'repo')])).fragments[0]?.removed).toBe(true)
  })

  it('names an id two modules both declare, and shows the first', async () => {
    await module('repo/a', model('a', { fragments: [fragment('x.Twice')] }))
    const second = await module('repo/b', model('b', { fragments: [fragment('x.Twice')] }))
    const catalog = await readCatalog([join(dir, 'repo')])
    expect(catalog.fragments).toMatchObject([{ id: 'x.Twice', module: 'a' }])
    expect(catalog.problems).toEqual([{ file: second, message: 'x.Twice is declared in a and in b; the studio shows the first.' }])
  })

  it('names a file it cannot read, and a path with nothing there, and reads the rest', async () => {
    const broken = await module('repo/broken', '{')
    await module('repo/good', model('good', { fragments: [fragment('x.Good')] }))
    const catalog = await readCatalog([join(dir, 'repo'), join(dir, 'missing')])
    expect(catalog.fragments.map(f => f.id)).toEqual(['x.Good'])
    expect(catalog.problems.map(p => p.file)).toEqual([broken, join(dir, 'missing')])
  })

  it('reads a file under two of the paths once', async () => {
    const file = await module('repo/a', model('a', { fragments: [fragment('x.A')] }))
    const catalog = await readCatalog([join(dir, 'repo'), file])
    expect(catalog.models).toHaveLength(1)
    expect(catalog.problems).toEqual([])
  })
})

describe('the paths to look in', () => {
  it('keeps what is added, after those the environment names, and removes it again', async () => {
    process.env.DRIVINE_STUDIO_MODELS = ['/from/env', ''].join(':')
    await mkdir(join(dir, 'project'))
    expect(await addModelPath(` ${join(dir, 'project')} `)).toEqual([
      { path: '/from/env', source: 'environment' },
      { path: join(dir, 'project'), source: 'studio' },
    ])
    expect(await addModelPath(join(dir, 'project'))).toHaveLength(2)
    expect(await removeModelPath(join(dir, 'project'))).toEqual([{ path: '/from/env', source: 'environment' }])
  })

  it.each([
    ['', 'Give a folder or a model file.'],
    ['relative/path', 'Give the whole path, from the root'],
    ['/nothing/here/at/all', 'There is nothing at'],
  ])('refuses to add %j', async (path, message) => {
    await expect(addModelPath(path)).rejects.toThrow(ModelPathError)
    await expect(addModelPath(path)).rejects.toThrow(message)
  })

  it('will not remove a path the environment names', async () => {
    process.env.DRIVINE_STUDIO_MODELS = '/from/env'
    await expect(removeModelPath('/from/env')).rejects.toThrow(ModelPathError)
    expect(await listModelPaths()).toHaveLength(1)
  })
})
