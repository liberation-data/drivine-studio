import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type cytoscapeType from 'cytoscape'

/*
 * cytoscape-cola picks its frame function when it loads: with no window it calls each frame at once, so the stub must
 * be in place before it is imported. Frames are counted, and each runs on the next turn of the event loop.
 */
let frames = 0
vi.stubGlobal('window', { requestAnimationFrame: (fn: () => void) => { frames++; return setTimeout(fn, 0) } })

let cytoscape: typeof cytoscapeType
let ARRANGE: Record<string, unknown>
beforeAll(async () => {
  cytoscape = (await import('cytoscape')).default
  cytoscape.use((await import('cytoscape-cola')).default)
  ;({ ARRANGE } = await import('./GraphView'))
})
afterEach(() => { frames = 0 })

const ring = (n: number) => {
  const core = cytoscape({ headless: true, styleEnabled: true })
  core.add(Array.from({ length: n }, (_, i) => ({ group: 'nodes' as const, data: { id: `n${i}` } })))
  core.add(Array.from({ length: n }, (_, i) => ({ group: 'edges' as const, data: { id: `e${i}`, source: `n${i}`, target: `n${(i + 1) % n}` } })))
  return core
}
/*
 * A ring with a chord from each node across it: the chords pull against the ring, so it takes cola 6 to 12 seconds to
 * settle (measured), where a plain ring can settle exactly, and so stop on its own, in under 200 ms.
 */
const tangled = (n: number) => {
  const core = ring(n)
  core.add(Array.from({ length: n }, (_, i) => ({ group: 'edges' as const, data: { id: `c${i}`, source: `n${i}`, target: `n${(i * 7 + 3) % n}` } })))
  return core
}
const stopped = (layout: cytoscapeType.Layouts) => new Promise<void>(resolve => layout.one('layoutstop', () => resolve()))

describe('the first layout of a small graph', () => {
  it('gives the page back between frames, many ticks to each, and stops on its own', async () => {
    const core = ring(30)
    const layout = core.layout({ name: 'cola', fit: false, ...ARRANGE } as unknown as cytoscapeType.LayoutOptions)
    let done = false
    const end = stopped(layout).then(() => { done = true })
    layout.run()
    expect(done).toBe(false)
    await end
    // At one tick a frame, cola's default and what it falls back to for an option it doesn't know, this ring takes ~90.
    expect(frames).toBeLessThan(20)
    core.destroy()
  })

  it('stops at its time limit when it never settles, as the timer fires between frames', async () => {
    const core = tangled(30)
    // A threshold only a stopped simulation gets under, on a graph far from settling by then: only the time limit ends it.
    const layout = core.layout({ name: 'cola', fit: false, ...ARRANGE, convergenceThreshold: Number.MIN_VALUE, maxSimulationTime: 200 } as unknown as cytoscapeType.LayoutOptions)
    const end = stopped(layout)
    const started = Date.now()
    layout.run()
    await end
    // The timer ended it, not settling. It ends at all is the point: a busy machine may take a while past its 200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(Date.now() - started).toBeLessThan(15_000)
    core.destroy()
  }, 20_000)

  it('stops when stopped, on its next frame, and a core destroyed by then is left alone', async () => {
    const core = ring(30)
    const layout = core.layout({ name: 'cola', fit: false, ...ARRANGE } as unknown as cytoscapeType.LayoutOptions)
    const end = stopped(layout)
    layout.run()
    layout.stop()
    core.destroy()
    await end
    expect(core.destroyed()).toBe(true)
  })
})
