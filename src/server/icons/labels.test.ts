import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { choose, chosen, COMMON, common, embedder, iconsOf, NEAREST, nearestTo, RETRY, words } from './labels'
import type { Embed } from './labels'
import { isIcon } from './lucide'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-icons-'))
  process.env.DRIVINE_STUDIO_HOME = home
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

describe('words', () => {
  it('splits a label into its words, leaving out those that say how a class is used', () => {
    expect(words('WorkHistory')).toEqual(['work', 'history'])
    expect(words('SampleDocNode')).toEqual(['doc'])
    expect(words('HTTPServer')).toEqual(['http', 'server'])
    expect(words('created_at')).toEqual(['created', 'at'])
  })

  it('splits numbers from words and leaves them out, and keeps letters of any script', () => {
    expect(words('Address2')).toEqual(['address'])
    expect(words('HTTP2Server')).toEqual(['http', 'server'])
    expect(words('GrößeÄrzte')).toEqual(['größe', 'ärzte'])
    expect(words('人物')).toEqual(['人物'])
    expect(words('_')).toEqual([])
  })

  it('keeps a label made only of such words, rather than none', () => {
    expect(words('Node')).toEqual(['node'])
  })
})

describe('common', () => {
  it('takes the whole label, then each word from the last', () => {
    expect(common('Organization')).toBe('building')
    expect(common('GithubPerson')).toBe('user')
    expect(common('IssueCore')).toBe('circle-dot')
    expect(common('PurchaseOrder')).toBe('shopping-cart')
    expect(common('Address2')).toBe('map-pinned')
  })

  it("gives only Lucide's icons, as an upgrade of Lucide may rename one", () => {
    expect(Object.values(COMMON).filter(icon => !isIcon(icon))).toEqual([])
  })

  it('has nothing for a word it does not know', () => {
    expect(common('Probe')).toBeUndefined()
  })

  it("has nothing for a word an object is born with, such as an object's constructor", () => {
    expect(common('Constructor')).toBeUndefined()
    expect(common('ToString')).toBeUndefined()
  })
})

describe('nearestTo', () => {
  it('finds the icon whose stored vector is nearest, scaled back from bytes', () => {
    const icons = { model: 'm', dimensions: 2, names: ['a', 'b'], values: Int8Array.from([127, 0, 0, 127]) }
    expect(nearestTo([0, 1], icons)).toEqual({ icon: 'b', score: 1 })
    expect(nearestTo([0.6, 0.8], icons)).toEqual({ icon: 'b', score: 0.8 })
  })
})

describe('embedder', () => {
  const shared = globalThis as { drivineStudioEmbed?: unknown }
  beforeEach(() => {
    delete shared.drivineStudioEmbed
  })
  afterEach(() => {
    delete shared.drivineStudioEmbed
  })
  const model = async () => async () => [1]

  it('loads the model once for every label that asks at once', async () => {
    let loads = 0
    const load = async () => {
      loads++
      return model()
    }
    const all = await Promise.all([embedder(load, 0), embedder(load, 0), embedder(load, 0)])
    expect(loads).toBe(1)
    expect(new Set(all).size).toBe(1)
  })

  it('tries again for a model it could not load, once RETRY has passed', async () => {
    const offline = async () => {
      throw new Error('fetch failed')
    }
    expect(await embedder(offline, 0)).toBeNull()
    expect(await embedder(model, RETRY - 1)).toBeNull()
    expect(await embedder(model, RETRY)).toBeTypeOf('function')
  })
})

describe('iconsOf', () => {
  // A model that finds every label to be the given icon, or nothing like any.
  const vectors = JSON.parse(readFileSync(join(__dirname, 'icon-vectors.json'), 'utf8')) as { dimensions: number; names: string[] }
  const bytes = readFileSync(join(__dirname, 'icon-vectors.bin'))
  const like = (icon: string): Embed => async () => {
    const at = vectors.names.indexOf(icon) * vectors.dimensions
    return Array.from(new Int8Array(bytes.buffer, bytes.byteOffset + at, vectors.dimensions), it => it / 127)
  }
  const unlike: Embed = async () => new Array<number>(vectors.dimensions).fill(0)

  it('takes a chosen icon over a common word, and none chosen over any', async () => {
    await choose('Person', 'smile')
    await choose('Organization', null)
    const icons = await iconsOf(['Person', 'Organization', 'Team'], unlike)
    expect(icons).toEqual({
      Person: { icon: 'smile', source: 'chosen' },
      Organization: { icon: null, source: 'chosen' },
      Team: { icon: 'users', source: 'common' },
    })
  })

  it("forgets a choice, so the label's icon is found again", async () => {
    await choose('Person', 'smile')
    await choose('Person', undefined)
    expect(await chosen()).toEqual({})
    expect((await iconsOf(['Person'], unlike)).Person).toEqual({ icon: 'user', source: 'common' })
  })

  it('takes the nearest icon only when the model finds it near enough', async () => {
    const sure = (await iconsOf(['Probe'], like('flask-conical'))).Probe
    expect(sure).toMatchObject({ icon: 'flask-conical', source: 'nearest' })
    expect(sure?.score).toBeGreaterThanOrEqual(NEAREST)
    expect((await iconsOf(['Probe'], unlike)).Probe).toEqual({ icon: null, source: 'none', score: 0 })
  })

  it('takes a label named as an object is born with for a label, not a choice', async () => {
    const icons = await iconsOf(['toString', '__proto__'], unlike)
    expect(Object.keys(icons)).toEqual(['toString', '__proto__'])
    expect(icons.toString).toEqual({ icon: null, source: 'none', score: 0 })
    await choose('__proto__', 'smile')
    expect(await chosen()).toEqual(JSON.parse('{"__proto__":"smile"}'))
    expect((await iconsOf(['__proto__'], unlike))['__proto__']).toEqual({ icon: 'smile', source: 'chosen' })
  })

  it('asks no model of a label with no words', async () => {
    const never: Embed = async () => {
      throw new Error('asked')
    }
    expect((await iconsOf(['_'], never))._).toEqual({ icon: null, source: 'none' })
  })

  it('gives a label the model fails on no icon, and the others theirs', async () => {
    const failing: Embed = async () => {
      throw new Error('inference failed')
    }
    expect(await iconsOf(['Probe', 'Person'], failing)).toEqual({
      Probe: { icon: null, source: 'none' },
      Person: { icon: 'user', source: 'common' },
    })
  })
})
