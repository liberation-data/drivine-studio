/*
 * Graph Bench's dataset, made here as Graph Bench makes it (graph-bench `src/main/kotlin/bench/Data.kt`): the same
 * nodes and relationships, in the same order, at any scale. Each stream is seeded as Graph Bench seeds it, and Java's
 * SplittableRandom is reproduced bit for bit, so a graph loaded from the studio answers Graph Bench's workloads as one
 * loaded by Graph Bench does, and their digests agree. A test pins it to rows Graph Bench wrote.
 */

const MASK = (1n << 64n) - 1n
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n

/** java.util.SplittableRandom, as far as Graph Bench uses it. */
export class SplittableRandom {
  private seed: bigint

  constructor(seed: bigint) {
    this.seed = BigInt.asUintN(64, seed)
  }

  private nextSeed(): bigint {
    this.seed = (this.seed + GOLDEN_GAMMA) & MASK
    return this.seed
  }

  private static mix64(z: bigint): bigint {
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK
    return z ^ (z >> 31n)
  }

  private static mix32(z: bigint): number {
    z = ((z ^ (z >> 33n)) * 0x62a9d9ed799705f5n) & MASK
    return Number(BigInt.asIntN(32, (((z ^ (z >> 28n)) * 0xcb24d0a5c88c35b3n) & MASK) >> 32n))
  }

  /** A signed 32-bit int. */
  nextIntRaw(): number {
    return SplittableRandom.mix32(this.nextSeed())
  }

  /** A signed 64-bit long. */
  nextLongRaw(): bigint {
    return BigInt.asIntN(64, SplittableRandom.mix64(this.nextSeed()))
  }

  nextInt(bound: number): number {
    let r = this.nextIntRaw()
    const m = bound - 1
    if ((bound & m) === 0) return r & m
    for (let u = r >>> 1; ((u + m - (r = u % bound)) | 0) < 0; u = this.nextIntRaw() >>> 1);
    return r
  }

  nextLong(bound: number): number {
    const b = BigInt(bound)
    const m = b - 1n
    let r = this.nextLongRaw()
    if ((b & m) === 0n) return Number(r & m)
    for (let u = BigInt.asUintN(64, r) >> 1n; BigInt.asIntN(64, u + m - (r = u % b)) < 0n; u = BigInt.asUintN(64, this.nextLongRaw()) >> 1n);
    return Number(r)
  }

  nextDouble(): number {
    return Number(BigInt.asUintN(64, this.nextLongRaw()) >> 11n) * 2 ** -53
  }
}

/** How many of each node there are. A scale of 1 is about 1.1 million nodes and 4.5 million relationships. */
export class Scale {
  readonly orgs: number
  readonly persons: number
  readonly repos: number
  readonly topics: number
  readonly issues: number
  readonly comments: number

  constructor(readonly factor: number) {
    const of = (base: number) => Math.max(10, Math.trunc(base * factor))
    this.orgs = of(1_000)
    this.persons = of(100_000)
    this.repos = of(20_000)
    this.topics = Math.min(500, of(500))
    this.issues = of(250_000)
    this.comments = of(750_000)
  }

  get nodes(): number {
    return this.orgs + this.persons + this.repos + this.topics + this.issues + this.comments
  }

  /** About how many relationships: Graph Bench's graph has about four a node. An estimate, for what a load will write. */
  get relationships(): number {
    return this.nodes * 4
  }
}

/** The scales a load is offered at, from about 1,100 nodes to about 11 million. Past SLOW_SCALE, a load is long. */
export const SCALES = [0.001, 0.01, 0.1, 1, 3, 10] as const
export const SLOW_SCALE = 0.1

export type Props = Record<string, string | number>

/** A set of relationships of one type, from nodes of one label to nodes of another, as pairs of ids. */
export interface EdgeSet {
  type: string
  from: string
  to: string
  pairs: () => Iterable<[string, string]>
}

export const LABELS = ['Org', 'Person', 'Repo', 'Topic', 'Issue', 'Comment'] as const
export type Label = (typeof LABELS)[number]

const COUNTRIES = ['AU', 'DE', 'US', 'BR', 'IN', 'JP', 'FR', 'NL', 'CA', 'KE']
const LANGUAGES = ['Kotlin', 'Java', 'Rust', 'Go', 'Python', 'TypeScript', 'Swift', 'C++']
const WORDS = ('graph query index path node edge label merge match plan cache batch stream shard vector ' +
  'token latency commit schema driver cursor buffer thread socket parser').split(' ')

const random = (stream: number) => new SplittableRandom(0x5eedn * 31n + BigInt(stream))

/** An index below n, low ones far likelier: a few popular nodes and a long tail. */
const skewed = (r: SplittableRandom, n: number, power = 2) => Math.min(n - 1, Math.trunc(n * r.nextDouble() ** power))

const text = (r: SplittableRandom, count: number) => Array.from({ length: count }, () => WORDS[r.nextInt(WORDS.length)]).join(' ')

/** Whether i may follow j: for each two people only one direction is allowed, picked by a hash of the pair. */
function mayFollow(i: number, j: number): boolean {
  const low = BigInt(Math.min(i, j))
  const high = BigInt(Math.max(i, j))
  const bit = ((((low * 31n + high) * 0x9e3779b97f4a7c15n) & MASK) >> 40n) & 1n
  return (bit === 0n) === (i < j)
}

/** For each of the sources, the distinct targets pick gives it; seeded when it is read, so it reads the same each time. */
function fanOut(stream: number, sources: number, from: string, to: string, pick: (r: SplittableRandom, i: number, out: Set<number>) => void) {
  return function* (): Generator<[string, string]> {
    const r = random(stream)
    const targets = new Set<number>()
    for (let i = 0; i < sources; i++) {
      targets.clear()
      pick(r, i, targets)
      for (const t of targets) yield [`${from}${i}`, `${to}${t}`]
    }
  }
}

const repeat = (times: number, action: () => void) => {
  for (let i = 0; i < times; i++) action()
}

/** The graph, made the same way every time it is asked for. */
export class Dataset {
  private readonly issueRepo: Int32Array

  constructor(readonly scale: Scale) {
    const r = random(100)
    this.issueRepo = Int32Array.from({ length: scale.issues }, () => skewed(r, scale.repos))
  }

  count(label: Label): number {
    const s = this.scale
    return { Org: s.orgs, Person: s.persons, Repo: s.repos, Topic: s.topics, Issue: s.issues, Comment: s.comments }[label]
  }

  *nodes(label: Label): Generator<Props> {
    const s = this.scale
    switch (label) {
      case 'Org': {
        const r = random(1)
        for (let i = 0; i < s.orgs; i++) yield { id: `o${i}`, name: `Org ${i}`, country: COUNTRIES[r.nextInt(COUNTRIES.length)]! }
        return
      }
      case 'Person': {
        const r = random(2)
        for (let i = 0; i < s.persons; i++) yield { id: `p${i}`, name: `Person ${i}`, email: `p${i}@example.org`, karma: r.nextInt(10_000) }
        return
      }
      case 'Repo': {
        const r = random(3)
        for (let i = 0; i < s.repos; i++) {
          const language = LANGUAGES[r.nextInt(LANGUAGES.length)]!
          yield { id: `r${i}`, name: `repo-${i}`, language, stars: skewed(r, 50_000, 4) }
        }
        return
      }
      case 'Topic':
        for (let i = 0; i < s.topics; i++) yield { id: `t${i}`, name: `topic-${i}` }
        return
      case 'Issue': {
        const r = random(4)
        for (let i = 0; i < s.issues; i++) {
          const roll = r.nextInt(100)
          const title = `Issue ${i}: ${text(r, 6)}`
          const state = roll < 40 ? 'open' : roll < 95 ? 'closed' : 'triaged'
          const priority = 1 + r.nextInt(4)
          const createdAt = 1_700_000_000_000 + r.nextLong(50_000_000_000)
          yield { id: `i${i}`, title, state, priority, createdAt, repoKey: `r${this.issueRepo[i]}` }
        }
        return
      }
      case 'Comment': {
        const r = random(5)
        for (let i = 0; i < s.comments; i++) {
          const body = text(r, 12 + r.nextInt(20))
          yield { id: `c${i}`, body, createdAt: 1_700_000_000_000 + r.nextLong(50_000_000_000) }
        }
        return
      }
    }
  }

  get edges(): EdgeSet[] {
    const s = this.scale
    const set = (type: string, from: Label, to: Label, pairs: () => Iterable<[string, string]>): EdgeSet => ({ type, from, to, pairs })
    return [
      set('MEMBER_OF', 'Person', 'Org', fanOut(10, s.persons, 'p', 'o', (r, _, out) => {
        repeat(r.nextInt(100) < 30 ? 2 : 1, () => out.add(skewed(r, s.orgs)))
      })),
      set('FOLLOWS', 'Person', 'Person', fanOut(11, s.persons, 'p', 'p', (r, i, out) => {
        const wanted = 1 + Math.trunc(60 * r.nextDouble() ** 3)
        let tries = 0
        while (out.size < wanted && tries++ < wanted * 4) {
          const j = skewed(r, s.persons)
          if (j !== i && mayFollow(i, j)) out.add(j)
        }
      })),
      set('OWNED_BY', 'Repo', 'Org', fanOut(12, s.repos, 'r', 'o', (r, _, out) => void out.add(skewed(r, s.orgs)))),
      set('DEPENDS_ON', 'Repo', 'Repo', fanOut(13, s.repos, 'r', 'r', (r, i, out) => {
        if (i > 0) repeat(r.nextInt(9), () => out.add(skewed(r, i)))
      })),
      set('IN_REPO', 'Issue', 'Repo', fanOut(19, s.issues, 'i', 'r', (_, i, out) => void out.add(this.issueRepo[i]!))),
      set('OPENED_BY', 'Issue', 'Person', fanOut(14, s.issues, 'i', 'p', (r, _, out) => void out.add(skewed(r, s.persons)))),
      set('ASSIGNED_TO', 'Issue', 'Person', fanOut(15, s.issues, 'i', 'p', (r, _, out) => {
        const roll = r.nextInt(100)
        repeat(roll < 40 ? 0 : roll < 80 ? 1 : 2, () => out.add(r.nextInt(s.persons)))
      })),
      set('TAGGED', 'Issue', 'Topic', fanOut(16, s.issues, 'i', 't', (r, _, out) => {
        repeat(1 + r.nextInt(3), () => out.add(skewed(r, s.topics)))
      })),
      set('ON', 'Comment', 'Issue', fanOut(17, s.comments, 'c', 'i', (r, _, out) => void out.add(skewed(r, s.issues, 1.5)))),
      set('WRITTEN_BY', 'Comment', 'Person', fanOut(18, s.comments, 'c', 'p', (r, _, out) => void out.add(skewed(r, s.persons)))),
    ]
  }
}
