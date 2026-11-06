import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allows, choose, chooseWord, chosen, COMMON, common, commonWord, embedder, explain, iconsFile, iconsOf, NEAREST, nearestTo, ONLY_BY_NAME, rankTo,
  RETRY, takeOnlyByName, wordOf, words,
} from './labels'
import type { Embed } from './labels'
import { isIcon } from './lucide'

// A model that finds every label to be the given icon, or nothing like any.
const vectors = JSON.parse(readFileSync(join(__dirname, 'icon-vectors.json'), 'utf8')) as { dimensions: number; names: string[] }
const bytes = readFileSync(join(__dirname, 'icon-vectors.bin'))
const like = (icon: string): Embed => async () => {
  const at = vectors.names.indexOf(icon) * vectors.dimensions
  return Array.from(new Int8Array(bytes.buffer, bytes.byteOffset + at, vectors.dimensions), it => it / 127)
}
const unlike: Embed = async () => new Array<number>(vectors.dimensions).fill(0)

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
    expect(common('ContentElement')).toBe('file-text')
    expect(common('Persona')).toBe('venetian-mask')
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
    expect(common('Constructor', Object.create(null))).toBeUndefined()
  })

  it("takes the person's own words, before COMMON's, the whole label first", () => {
    const own = { probe: 'radar', order: 'list-ordered', workhistory: 'history' }
    expect(common('Probe', own)).toBe('radar')
    expect(common('PurchaseOrder', own)).toBe('list-ordered')
    expect(common('WorkHistory', own)).toBe('history')
    // The whole label is looked up first, in both lists, before any of its words.
    expect(common('WorkPerson', { workperson: 'briefcase' })).toBe('briefcase')
    expect(common('Person', own)).toBe('user')
  })

  it('says which word gave the icon, and whose it is', () => {
    expect(commonWord('GithubPerson')).toEqual({ word: 'person', icon: 'user', own: false })
    expect(commonWord('SpaceProbe', { probe: 'radar' })).toEqual({ word: 'probe', icon: 'radar', own: true })
    expect(commonWord('Probe')).toBeUndefined()
  })
})

describe('wordOf', () => {
  it('makes a word for the list as a label is looked up', () => {
    expect(wordOf('Work History')).toBe('workhistory')
    expect(wordOf('WorkHistory')).toBe('workhistory')
    expect(wordOf('ChunkNode')).toBe('chunk')
    expect(wordOf('Größe')).toBe('größe')
    expect(wordOf(' - ')).toBe('')
  })
})

describe('nearestTo', () => {
  it('finds the icon whose stored vector is nearest, scaled back from bytes', () => {
    const icons = { model: 'm', dimensions: 2, names: ['a', 'b'], values: Int8Array.from([127, 0, 0, 127]) }
    expect(nearestTo([0, 1], icons)).toEqual({ icon: 'b', score: 1 })
    expect(nearestTo([0.6, 0.8], icons)).toEqual({ icon: 'b', score: 0.8 })
  })

  it('ranks the nearest few, nearest first, and none when asked for none', () => {
    const icons = { model: 'm', dimensions: 2, names: ['a', 'b', 'c'], values: Int8Array.from([127, 0, 0, 127, 90, 90]) }
    expect(rankTo([0.6, 0.8], icons, () => true, 2).map(it => it.icon)).toEqual(['c', 'b'])
    expect(rankTo([0.6, 0.8], icons, () => true, 5).map(it => it.icon)).toEqual(['c', 'b', 'a'])
    expect(rankTo([0.6, 0.8], icons, icon => icon !== 'c', 2).map(it => it.icon)).toEqual(['b', 'a'])
    expect(rankTo([0.6, 0.8], icons, () => true, 0)).toEqual([])
  })

  it('passes over an icon it is not allowed, for the next nearest', () => {
    const icons = { model: 'm', dimensions: 2, names: ['a', 'b'], values: Int8Array.from([127, 0, 0, 127]) }
    expect(nearestTo([0.6, 0.8], icons, icon => icon !== 'b')).toEqual({ icon: 'a', score: 0.6 })
  })
})

describe('allows', () => {
  it('takes an icon of one particular thing only for a label that names it', () => {
    expect(allows(words('Patient'), 'cigarette')).toBe(false)
    expect(allows(words('Category'), 'cat')).toBe(false)
    expect(allows(words('Cigarette'), 'cigarette')).toBe(true)
    expect(allows(words('PhoneNumber'), 'phone')).toBe(true)
  })

  it('takes any other icon for any label', () => {
    expect(allows(words('Drug'), 'tablets')).toBe(true)
  })

  it("lists only Lucide's icons, as an upgrade of Lucide may rename one", () => {
    expect([...ONLY_BY_NAME].filter(icon => !isIcon(icon))).toEqual([])
  })

  it("takes an icon on the person's own list only for a label that names it, as one on ONLY_BY_NAME", () => {
    expect(allows(words('Drug'), 'tablets', ['tablets'])).toBe(false)
    expect(allows(words('Tablets'), 'tablets', ['tablets'])).toBe(true)
    expect(allows(words('Patient'), 'cigarette', ['tablets'])).toBe(false)
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

  it('gives the model\'s icon of one particular thing only to a label that names it', async () => {
    const icons = await iconsOf(['Patient', 'Cigarette'], like('cigarette'))
    expect(icons.Patient?.icon).not.toBe('cigarette')
    expect(icons.Cigarette).toMatchObject({ icon: 'cigarette', source: 'nearest' })
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

describe('the icons file', () => {
  it('reads a file from before the lists, with only the choices in it, and keeps them as the lists change', async () => {
    await writeFile(join(home, 'icons.json'), JSON.stringify({ labels: { Metro: 'square-m', Org: null } }))
    expect(await iconsFile()).toEqual({ labels: { Metro: 'square-m', Org: null }, words: {}, onlyByName: [] })
    await chooseWord('probe', 'radar')
    await takeOnlyByName('tablets', true)
    await choose('Person', 'smile')
    expect(JSON.parse(await readFile(join(home, 'icons.json'), 'utf8'))).toEqual({
      labels: { Metro: 'square-m', Org: null, Person: 'smile' },
      words: { probe: 'radar' },
      onlyByName: ['tablets'],
    })
  })

  it('leaves out what is not a list of the kind it should be, rather than failing on it', async () => {
    await writeFile(join(home, 'icons.json'), JSON.stringify({ labels: { A: 1, B: 'bug' }, words: ['x'], onlyByName: 'cat' }))
    expect(await iconsFile()).toEqual({ labels: { B: 'bug' }, words: {}, onlyByName: [] })
  })

  it('keeps every change made at once, to the choices and both lists alike', async () => {
    await Promise.all([chooseWord('probe', 'radar'), takeOnlyByName('tablets', true), choose('Person', 'smile'), chooseWord('order', 'list-ordered')])
    expect(await iconsFile()).toEqual({
      labels: { Person: 'smile' },
      words: { probe: 'radar', order: 'list-ordered' },
      onlyByName: ['tablets'],
    })
  })

  it('takes a word or an icon off the lists again', async () => {
    await chooseWord('probe', 'radar')
    await chooseWord('probe', undefined)
    await takeOnlyByName('tablets', true)
    await takeOnlyByName('tablets', true)
    expect((await iconsFile()).onlyByName).toEqual(['tablets'])
    await takeOnlyByName('tablets', false)
    expect(await iconsFile()).toEqual({ labels: {}, words: {}, onlyByName: [] })
  })
})

describe("iconsOf, with the person's own lists", () => {

  it('gives a label the icon of a word of their own, before the model and before COMMON', async () => {
    await chooseWord('probe', 'radar')
    await chooseWord('order', 'list-ordered')
    const icons = await iconsOf(['SpaceProbe', 'PurchaseOrder'], like('flask-conical'))
    expect(icons).toEqual({ SpaceProbe: { icon: 'radar', source: 'common' }, PurchaseOrder: { icon: 'list-ordered', source: 'common' } })
  })

  it('takes an icon on their own list only for a label that names it', async () => {
    await takeOnlyByName('flask-conical', true)
    const icons = await iconsOf(['Probe', 'Flask'], like('flask-conical'))
    expect(icons.Probe?.icon).not.toBe('flask-conical')
    expect(icons.Flask).toMatchObject({ icon: 'flask-conical', source: 'nearest' })
  })
})

describe('explain', () => {

  it("gives each label's icon as iconsOf does, with the model's nearest few beside it", async () => {
    await choose('Person', 'smile')
    const found = await explain(['Probe', 'Person'], 3, like('flask-conical'))
    expect(found.Probe).toMatchObject({ icon: 'flask-conical', source: 'nearest' })
    expect(found.Probe?.picks).toHaveLength(3)
    expect(found.Probe?.picks[0]).toEqual({ icon: 'flask-conical', score: found.Probe?.score })
    const scores = found.Probe!.picks.map(it => it.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(found.Person).toMatchObject({ icon: 'smile', source: 'chosen' })
    expect(found.Person?.picks).toHaveLength(3)
  })

  it('says which word gave a common icon, and whether the word is their own', async () => {
    await chooseWord('probe', 'radar')
    const found = await explain(['GithubPerson', 'SpaceProbe'], 1, unlike)
    expect(found.GithubPerson).toMatchObject({ icon: 'user', source: 'common', word: 'person', own: false })
    expect(found.SpaceProbe).toMatchObject({ icon: 'radar', source: 'common', word: 'probe', own: true })
  })

  it("gives a label with no icon the model's picks all the same, so one can be chosen with a click", async () => {
    const found = await explain(['Probe'], 2, unlike)
    expect(found.Probe).toMatchObject({ icon: null, source: 'none', score: 0 })
    expect(found.Probe?.picks).toHaveLength(2)
  })

  it('gives no picks where the model fails, and the label the icon it has without it', async () => {
    const failing: Embed = async () => {
      throw new Error('inference failed')
    }
    expect(await explain(['Probe', 'Person'], 3, failing)).toEqual({
      Probe: { icon: null, source: 'none', picks: [] },
      Person: { icon: 'user', source: 'common', word: 'person', own: false, picks: [] },
    })
  })

  it('leaves out of the picks an icon taken only by name', async () => {
    const found = await explain(['Patient'], 5, like('cigarette'))
    expect(found.Patient?.picks.map(it => it.icon)).not.toContain('cigarette')
  })
})
