import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { choose, chosen, common, iconsOf, NEAREST, nearestTo, words } from './labels'
import type { Embed } from './labels'

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
  })

  it('has nothing for a word it does not know', () => {
    expect(common('Probe')).toBeUndefined()
  })
})

describe('nearestTo', () => {
  it('finds the icon whose stored vector is nearest, scaled back from bytes', () => {
    const icons = { model: 'm', dimensions: 2, names: ['a', 'b'], values: Int8Array.from([127, 0, 0, 127]) }
    expect(nearestTo([0, 1], icons)).toEqual({ icon: 'b', score: 1 })
    expect(nearestTo([0.6, 0.8], icons)).toEqual({ icon: 'b', score: 0.8 })
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
})
